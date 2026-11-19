import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import test, { type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { TunnelRouter } from "../src/core/TunnelRouter";
import { LogManager } from "../src/core/LogManager";
import { loadHTTPProxy } from "./helpers/http-proxy";

async function listen(t: TestContext, server: Server | WebSocketServer) {
  if (server instanceof WebSocketServer) await once(server, "listening");
  else { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
  t.after(() => new Promise<void>(resolve => {
    if (server instanceof WebSocketServer) for (const ws of server.clients) ws.terminate();
    else server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("password comparison accepts only the exact password", async () => {
  const { passwordsMatch } = await loadHTTPProxy();
  assert.equal(passwordsMatch("s3cret", "s3cret"), true);
  for (const supplied of ["", "s3cre", "s3cret ", "S3cret", "s3cret".repeat(100)]) {
    assert.equal(passwordsMatch(supplied, "s3cret"), false);
  }
});

test("password-protected tunnels challenge wrong credentials and forward the right ones", { timeout: 5000 }, async t => {
  const { HTTPProxy } = await loadHTTPProxy();
  const router = new TunnelRouter();
  t.after(() => router.shutdown());
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const wsPort = await listen(t, wss);
  const accepted = once(wss, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const [edgeSide] = await accepted as [WebSocket];
  client.on("message", data => {
    const request = JSON.parse(String(data));
    client.send(JSON.stringify({ type: "response", requestId: request.requestId, statusCode: 200, headers: {}, body: Buffer.from("private").toString("base64") }));
  });
  edgeSide.on("message", data => router.handleMessage("locked.example.test", JSON.parse(String(data)), edgeSide));
  assert.ok(await router.registerTunnel("locked.example.test", edgeSide, { password: "s3cret" }));

  const proxy = new HTTPProxy(router, "example.test", new LogManager());
  const server = createServer((req, res) => void proxy.handleRequest(req, res));
  const port = await listen(t, server);
  const get = (password?: string) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const headers = { host: "locked.example.test", ...(password === undefined ? {} : { authorization: `Basic ${Buffer.from(`user:${password}`).toString("base64")}` }) };
    request({ host: "127.0.0.1", port, path: "/", headers, agent: false }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", reject).end();
  });
  for (const password of [undefined, "wrong", "s3cre", "s3cret!"]) {
    const response = await get(password);
    assert.equal(response.status, 401);
    assert.match(String(response.headers["www-authenticate"]), /^Basic/);
  }
  const ok = await get("s3cret");
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "private");
});
