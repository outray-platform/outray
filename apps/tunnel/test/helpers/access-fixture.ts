import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { TunnelRouter, type TunnelMetadata } from "../../src/core/TunnelRouter";
import { LogManager } from "../../src/core/LogManager";
import { WSProxy } from "../../src/core/WSProxy";
import { TunnelAccessGate, type TunnelAccessGateOptions } from "../../src/lib/tunnel-access-gate";
import { loadHTTPProxy } from "./http-proxy";

export const ORG = "org-a";
export const USER = "user-a";
export const CONSOLE = "https://console.example.test";
export const navigate = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html" };

export interface HttpResult { status: number; headers: IncomingHttpHeaders; body: string }

export async function listen(t: TestContext, server: Server | WebSocketServer): Promise<number> {
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

/** A stand-in for the console's edge endpoints, with the same single-use and host-binding rules. */
export class FakeConsole {
  codes = new Map<string, { host: string; userId: string; organizationId: string; returnPath: string }>();
  members = new Set([`${ORG}:${USER}`]);
  calls: Array<{ path: string; body: Record<string, string>; authorization?: string }> = [];
  down = false;

  issue(host: string, returnPath = "/", userId = USER, organizationId = ORG) {
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { host, userId, organizationId, returnPath });
    return code;
  }

  fetch: typeof fetch = async (url, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const path = new URL(String(url)).pathname.replace(/^\/api/, "");
    const body = JSON.parse(String(init?.body));
    const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    this.calls.push({ path, body, authorization });
    if (authorization !== "Bearer edge-secret") return Response.json({ valid: false }, { status: 401 });
    if (path === "/tunnel/access/redeem") {
      const entry = this.codes.get(body.code);
      this.codes.delete(body.code);
      if (!entry || entry.host !== body.host || !this.members.has(`${entry.organizationId}:${entry.userId}`)) return Response.json({ valid: false });
      return Response.json({ valid: true, userId: entry.userId, organizationId: entry.organizationId, returnPath: entry.returnPath });
    }
    if (path === "/tunnel/access/revalidate") {
      return Response.json({ valid: this.members.has(`${body.organizationId}:${body.userId}`) });
    }
    throw new Error(`Unexpected console call ${path}`);
  };
}

export async function accessFixture(t: TestContext, options: Partial<TunnelAccessGateOptions> = {}) {
  const { HTTPProxy } = await loadHTTPProxy();
  const console_ = new FakeConsole();
  let now = Date.UTC(2026, 10, 19);
  const gate = new TunnelAccessGate({
    consoleUrl: CONSOLE, apiUrl: "https://console.example.test/api", internalApiSecret: "edge-secret",
    secureCookies: true, fetch: (url, init) => console_.fetch(url, init), now: () => now, ...options,
  });
  const router = new TunnelRouter();
  t.after(() => router.shutdown());
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const wsPort = await listen(t, wss);
  const received: Array<{ host: string; path: string; headers: Record<string, string | string[]> }> = [];
  const upgrades: Array<{ host: string; path: string; headers: Record<string, string | string[]> }> = [];
  const wsProxy = new WSProxy(router, gate, 60_000);
  const visitors: WebSocket[] = [];
  const hosts: string[] = [];
  // Upgraded sockets are detached from the HTTP server, so they must close before it can.
  t.after(() => {
    wsProxy.shutdown();
    for (const ws of visitors) ws.terminate();
    for (const host of hosts) wsProxy.cleanupTunnel(host);
  });

  async function tunnel(host: string, metadata: TunnelMetadata = {}) {
    hosts.push(host);
    const accepted = once(wss, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    const [edge] = await accepted as [WebSocket];
    client.on("message", data => {
      const message = JSON.parse(String(data));
      if (message.type === "ws_upgrade") {
        upgrades.push({ host, path: message.path, headers: message.headers });
        client.send(JSON.stringify({ type: "ws_upgrade_response", wsConnectionId: message.wsConnectionId, success: true }));
        return;
      }
      if (message.type !== "request") return;
      received.push({ host, path: message.path, headers: message.headers });
      client.send(JSON.stringify({ type: "response", requestId: message.requestId, statusCode: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(`app:${message.path}`).toString("base64") }));
    });
    edge.on("message", data => {
      const message = JSON.parse(String(data));
      if (message.type === "ws_upgrade_response") wsProxy.handleUpgradeResponse(message, edge);
      else router.handleMessage(host, message, edge);
    });
    assert.ok(await router.registerTunnel(host, edge, { organizationId: ORG, plan: "pro", access: "organization", ...metadata }));
    return { client, edge };
  }

  const proxy = new HTTPProxy(router, "example.test", new LogManager(), gate);
  const server = createServer((req, res) => void proxy.handleRequest(req, res));
  server.on("upgrade", (req, socket, head) => void wsProxy.handleUpgrade(req, socket, head));
  const port = await listen(t, server);

  function send(host: string, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port, path, method, headers: { host, ...headers }, agent: false }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      }).on("error", reject).end();
    });
  }

  /** Resolves with the opened socket, or the HTTP status the upgrade was refused with. */
  function upgrade(host: string, path: string, headers: Record<string, string> = {}): Promise<WebSocket | number> {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { host, ...headers } });
      ws.on("open", () => resolve(ws));
      ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode!); res.resume(); });
      ws.on("error", () => {});
      visitors.push(ws);
    });
  }

  async function signIn(host: string, returnPath = "/") {
    const response = await send(host, `/_outray/callback?code=${console_.issue(host, returnPath)}`, navigate);
    assert.equal(response.status, 302);
    const cookie = String(response.headers["set-cookie"]?.[0]).split(";", 1)[0];
    return { response, cookie };
  }

  return {
    gate, router, wsProxy, console: console_, received, upgrades, tunnel, send, upgrade, signIn,
    advance(ms: number) { now += ms; },
  };
}
