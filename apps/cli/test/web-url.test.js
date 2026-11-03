const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vm = require("node:vm");
const { WebSocketServer } = require("ws");
const { canonicalConsoleOrigin } = require("../dist/config.js");

// Evaluate the built CLI's URL initializers without importing its main entry,
// which would start commands, read local credentials, or contact the network.
const entry = fs.readFileSync(
  path.resolve(__dirname, "../dist/index.js"),
  "utf8",
);
const isDevDeclaration = entry.match(/^\s*const isDev =[^;]+;/m)?.[0];
const serverUrlDeclaration = entry.match(
  /^\s*const serverUrl =\s*process\.env\.OUTRAY_SERVER_URL[^;]+;/m,
)?.[0];
const webUrlDeclaration = entry.match(/^\s*const webUrl =[^;]+;/m)?.[0];
assert.ok(isDevDeclaration, "CLI must expose its development-mode initializer");
assert.ok(serverUrlDeclaration, "CLI must expose its tunnel URL initializer");
assert.ok(webUrlDeclaration, "CLI must expose its console URL initializer");
const initializer = new vm.Script(
  `const args = process.argv.slice(2);\n${isDevDeclaration}\n${webUrlDeclaration}\nwebUrl;`,
);
const serverInitializer = new vm.Script(
  `const args = process.argv.slice(2);\n${isDevDeclaration}\n${serverUrlDeclaration}\nserverUrl;`,
);

function webUrl(env = {}, args = []) {
  return initializer.runInNewContext({
    process: { env, argv: ["node", "outray", ...args] },
    config_1: { canonicalConsoleOrigin },
  });
}

function serverUrl(env = {}, args = []) {
  return serverInitializer.runInNewContext({
    process: { env, argv: ["node", "outray", ...args] },
  });
}

test("production CLI uses outray.co for browser auth and connect.outray.co for tunnels", () => {
  assert.equal(serverUrl(), "wss://connect.outray.co/");
  assert.equal(
    serverUrl({ NODE_ENV: "production" }),
    "wss://connect.outray.co/",
  );
  assert.equal(webUrl(), "https://outray.co");
});

test("development and dev-flag tunnel connections keep the local server", () => {
  assert.equal(serverUrl({ NODE_ENV: "development" }), "ws://localhost:3547");
  assert.equal(
    serverUrl({ NODE_ENV: "production" }, ["--dev"]),
    "ws://localhost:3547",
  );
});

test("OUTRAY_SERVER_URL retains custom and legacy endpoint overrides", () => {
  for (const override of [
    "wss://api.outray.dev/",
    "wss://tunnel.example.test/",
  ]) {
    assert.equal(serverUrl({ OUTRAY_SERVER_URL: override }), override);
    assert.equal(
      serverUrl({ NODE_ENV: "development", OUTRAY_SERVER_URL: override }),
      override,
    );
    assert.equal(
      serverUrl({ OUTRAY_SERVER_URL: override }, ["--dev"]),
      override,
    );
  }
  assert.equal(
    serverUrl({ OUTRAY_SERVER_URL: "" }),
    "wss://connect.outray.co/",
  );
});

test("production secrets commands use the console with the Secrets API", () => {
  const args = ["secrets", "run", "--", "nest", "start"];
  assert.equal(webUrl({}, args), "https://outray.co");
  assert.equal(webUrl({ NODE_ENV: "production" }, args), "https://outray.co");
});

test("development environment keeps the local console URL", () => {
  assert.equal(webUrl({ NODE_ENV: "development" }), "http://localhost:6767");
});

test("the dev flag keeps the local console URL", () => {
  assert.equal(
    webUrl({ NODE_ENV: "production" }, ["--dev"]),
    "http://localhost:6767",
  );
});

test("OUTRAY_WEB_URL overrides the production and development defaults", () => {
  const override = "https://console.example.test";
  assert.equal(webUrl({ OUTRAY_WEB_URL: override }), override);
  assert.equal(
    webUrl({ NODE_ENV: "development", OUTRAY_WEB_URL: override }),
    override,
  );
  assert.equal(webUrl({ OUTRAY_WEB_URL: override }, ["--dev"]), override);
  assert.equal(webUrl({ OUTRAY_WEB_URL: "https://outray.dev" }), "https://outray.co");
});

test("an empty override falls back to the environment's console URL", () => {
  assert.equal(webUrl({ OUTRAY_WEB_URL: "" }), "https://outray.co");
  assert.equal(
    webUrl({ NODE_ENV: "development", OUTRAY_WEB_URL: "" }),
    "http://localhost:6767",
  );
});

test("custom console URL is normalized and unsafe origins fail before loading credentials", () => {
  assert.equal(
    webUrl({ OUTRAY_WEB_URL: "https://CONSOLE.EXAMPLE.TEST:443/" }),
    "https://console.example.test",
  );
  for (const override of [
    "http://console.example.test",
    "https://user:password@console.example.test",
    "https://console.example.test/path",
    "https://console.example.test/?query=1",
    "https://console.example.test/#key",
  ]) {
    assert.throws(() => webUrl({ OUTRAY_WEB_URL: override }), /OUTRAY_WEB_URL/);
  }
});

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runCli(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(__dirname, "../dist/index.js");
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

test("doctor checks runtime, API auth, DNS, configured relay, and loopback", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outray-doctor-"));
  const configDir = path.join(tempDir, "outray");
  fs.mkdirSync(configDir);

  let authorization;
  const api = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(authorization === "Bearer doctor-key" ? 200 : 401, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        authorization === "Bearer doctor-key"
          ? { organizations: [] }
          : { error: "unauthorized" },
      ),
    );
  });
  await waitForListening(api);

  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => relay.once("listening", resolve));
  const relayAddress = relay.address();
  fs.writeFileSync(
    path.join(configDir, "config.toml"),
    `[global]\nserver_url = "ws://127.0.0.1:${relayAddress.port}"\n`,
  );

  const env = {
    ...process.env,
    HOME: tempDir,
    OUTRAY_WEB_URL: `http://127.0.0.1:${api.address().port}`,
    OUTRAY_SERVER_URL: "ws://127.0.0.1:1",
    OUTRAY_TOKEN: "",
    OUTRAY_API_KEY: "",
  };

  t.after(async () => {
    await closeServer(api);
    await new Promise((resolve) => relay.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = await runCli(["doctor", "--key", "doctor-key"], tempDir, env);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const output = result.stdout.replace(/\u001b\[[0-9;]*m/g, "");
  assert.equal(authorization, "Bearer doctor-key");
  assert.match(output, /\[PASS\] Runtime:/);
  assert.match(output, /\[PASS\] API credentials:/);
  assert.match(output, /\[PASS\] DNS:/);
  assert.match(output, /\[PASS\] Edge relay: WebSocket handshake succeeded/);
  assert.match(output, /\[PASS\] Local loopback:/);
  assert.equal((output.match(/\[(?:PASS|FAIL)\]/g) || []).length, 5);

  const rejected = await runCli(
    ["doctor", "--key", "invalid-key"],
    tempDir,
    env,
  );
  const rejectedOutput = rejected.stdout.replace(/\u001b\[[0-9;]*m/g, "");
  assert.equal(rejected.code, 1);
  assert.match(
    rejectedOutput,
    /\[FAIL\] API credentials: Credential rejected \(HTTP 401\)/,
  );
  assert.doesNotMatch(rejectedOutput, /invalid-key/);
});
