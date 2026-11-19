const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { resolveAccessOptions } = require("../dist/tunnel-access.js");
const { TomlConfigParser } = require("../dist/toml-config.js");

function cli(t, args, serverUrl) {
  const home = mkdtempSync(path.join(tmpdir(), "outray-access-cli-"));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../dist/index.js"), ...args], {
    env: { ...process.env, HOME: home, NODE_ENV: "test", OUTRAY_SERVER_URL: serverUrl, OUTRAY_WEB_URL: "http://127.0.0.1:1", FORCE_COLOR: "0" },
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); rmSync(home, { recursive: true, force: true }); });
  return { child, output: () => output };
}

async function edge(t, reply) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  const handshakes = [];
  server.on("connection", ws => ws.once("message", data => {
    handshakes.push(JSON.parse(String(data)));
    reply(ws);
  }));
  return { url: `ws://127.0.0.1:${server.address().port}`, handshakes };
}

test("--access org sends organization access and bypass prefixes in the handshake", { timeout: 5000 }, async t => {
  const server = await edge(t, ws => {
    ws.send(JSON.stringify({ type: "tunnel_opened", tunnelId: "app.example.test", url: "https://app.example.test" }));
    ws.send(JSON.stringify({ type: "error", code: "AUTH_FAILED", message: "stop" }));
  });
  const f = cli(t, ["3000", "--key", "token", "--access", "org", "--access-bypass", "/webhooks", "--access-bypass=/health,/status"], server.url);
  await once(f.child, "close");
  assert.equal(server.handshakes.length, 1);
  assert.equal(server.handshakes[0].access, "organization");
  assert.deepEqual(server.handshakes[0].accessBypass, ["/webhooks", "/health", "/status"]);
  assert.equal(server.handshakes[0].password, undefined);
});

test("organization access errors from the edge stop the CLI without reconnecting", { timeout: 5000 }, async t => {
  for (const code of ["ORG_ACCESS_REQUIRES_PAID", "ORG_ACCESS_UNAVAILABLE", "INVALID_ACCESS"]) {
    const server = await edge(t, ws => ws.send(JSON.stringify({ type: "error", code, message: `edge said ${code}` })));
    const f = cli(t, ["3000", "--key", "token", "--access", "org"], server.url);
    const [exitCode] = await once(f.child, "close");
    assert.equal(exitCode, 1);
    assert.equal(server.handshakes.length, 1);
    assert.match(f.output(), new RegExp(`edge said ${code}`));
  }
});

test("invalid access flag combinations fail before connecting", { timeout: 10000 }, async t => {
  for (const [args, pattern] of [
    [["3000", "--key", "token", "--access", "org", "--password", "x"], /cannot be used together/],
    [["3000", "--key", "token", "--access", "everyone"], /must be one of/],
    [["3000", "--key", "token", "--access"], /requires a mode/],
    [["3000", "--key", "token", "--access-bypass", "/webhooks"], /requires --access org/],
    [["3000", "--key", "token", "--access", "org", "--access-bypass", "/a/../b"], /Invalid --access-bypass/],
    [["tcp", "5432", "--key", "token", "--access", "org"], /only for HTTP/],
    [["3000", "--key", "token", "--access", "password"], /requires --password/],
  ]) {
    const f = cli(t, args, "ws://127.0.0.1:1");
    const [code] = await once(f.child, "close");
    assert.equal(code, 1, args.join(" "));
    assert.match(f.output(), pattern);
  }
});

test("a guest CLI cannot request organization access", { timeout: 5000 }, async t => {
  const f = cli(t, ["3000", "--access", "org"], "ws://127.0.0.1:1");
  const [code] = await once(f.child, "close");
  assert.equal(code, 1);
  assert.match(f.output(), /requires authentication/);
  assert.doesNotMatch(f.output(), /Guest HTTP tunnel/);
});

test("access options normalize aliases and keep password mode explicit", () => {
  assert.deepEqual(resolveAccessOptions({ access: "ORG", protocol: "http" }), { ok: true, access: "organization", accessBypass: undefined });
  assert.deepEqual(resolveAccessOptions({ password: "x", protocol: "http" }), { ok: true, access: undefined, accessBypass: undefined });
  assert.equal(resolveAccessOptions({ access: "public", password: "x", protocol: "http" }).ok, false);
});

test("config.toml accepts organization access and rejects conflicting settings", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "outray-access-toml-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.toml");
  writeFileSync(file, '[tunnel.web]\nprotocol = "http"\nlocal_port = 3000\naccess = "org"\naccess_bypass = ["/webhooks"]\n');
  const [tunnel] = TomlConfigParser.loadTomlConfig(file).tunnels;
  assert.equal(tunnel.access, "organization");
  assert.deepEqual(tunnel.accessBypass, ["/webhooks"]);
  writeFileSync(file, '[tunnel.web]\nprotocol = "http"\nlocal_port = 3000\naccess = "org"\npassword = "x"\n');
  assert.throws(() => TomlConfigParser.loadTomlConfig(file), /access org and password cannot be used together/i);
});
