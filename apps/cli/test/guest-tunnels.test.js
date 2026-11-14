const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");

function cli(t, args, serverUrl) {
  const home = mkdtempSync(path.join(tmpdir(), "outray-guest-cli-"));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../dist/index.js"), ...args], {
    env: { ...process.env, HOME: home, NODE_ENV: "test", OUTRAY_SERVER_URL: serverUrl, OUTRAY_WEB_URL: "http://127.0.0.1:1", FORCE_COLOR: "0" },
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); rmSync(home, { recursive: true, force: true }); });
  return { child, output: () => output };
}

test("a fresh CLI opens guest HTTP without a login and stops on expiry instead of reconnecting", { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  let handshake, connections = 0;
  server.on("connection", ws => {
    connections++;
    ws.once("message", data => {
      handshake = JSON.parse(String(data));
      ws.send(JSON.stringify({ type: "tunnel_opened", tunnelId: "guest.example.test", url: "https://guest.example.test" }));
      ws.send(JSON.stringify({ type: "error", code: "TUNNEL_EXPIRED", message: "Guest HTTP tunnels expire after 60 minutes" }));
    });
  });
  const f = cli(t, ["3000"], `ws://127.0.0.1:${server.address().port}`);
  const [code] = await once(f.child, "close");
  assert.equal(code, 1);
  assert.equal(connections, 1);
  assert.equal(handshake.type, "open_tunnel");
  assert.equal(handshake.apiKey, undefined);
  assert.match(f.output(), /Guest HTTP tunnel.*60 minutes/);
  assert.match(f.output(), /Tunnel ready/);
  assert.match(f.output(), /expire after 60 minutes/);
});

test("a fresh CLI requires credentials for TCP, UDP, domains, passwords and org selection", { timeout: 5000 }, async t => {
  for (const args of [["tcp", "3000"], ["udp", "3000"], ["3000", "--domain", "preview.example.test"], ["3000", "--password", "preview"], ["3000", "--org", "org-a"]]) {
    const f = cli(t, args, "ws://127.0.0.1:1");
    const [code] = await once(f.child, "close");
    assert.equal(code, 1);
    assert.match(f.output(), /requires authentication/);
    assert.doesNotMatch(f.output(), /Guest HTTP tunnel/);
  }
});

test("an explicitly empty CLI token cannot silently select guest mode", { timeout: 5000 }, async t => {
  const f = cli(t, ["3000", "--key="], "ws://127.0.0.1:1");
  const [code] = await once(f.child, "close");
  assert.equal(code, 1);
  assert.match(f.output(), /requires a nonempty authentication token/);
  assert.doesNotMatch(f.output(), /Guest HTTP tunnel/);
});

test("a policy close stops guest reconnection even without an error message", { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  let connections = 0;
  server.on("connection", ws => {
    connections++;
    ws.once("message", () => {
      ws.send(JSON.stringify({ type: "tunnel_opened", tunnelId: "guest.example.test", url: "https://guest.example.test" }));
      ws.close(1008, "Guest tunnel expired");
    });
  });
  const f = cli(t, ["3000"], `ws://127.0.0.1:${server.address().port}`);
  await once(f.child, "close");
  assert.equal(connections, 1);
  assert.match(f.output(), /Guest tunnel expired/);
  assert.doesNotMatch(f.output(), /Retrying/);
});
