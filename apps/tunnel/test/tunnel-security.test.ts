import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type Redis from "ioredis";
import { GuestTunnelLimits, GUEST_LIFETIME_MS } from "../src/lib/guest-tunnels";
import { isolatedRedis } from "./helpers/redis";
import { TunnelRouter } from "../src/core/TunnelRouter";
import { loadWSHandler } from "./helpers/ws-handler";
import type { TCPProxy } from "../src/core/TCPProxy";
import type { UDPProxy } from "../src/core/UDPProxy";

type Body = Record<string, any>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), "Expected tunnel cleanup to complete");
}
async function harness(t: TestContext, options: {
  redis?: Redis;
  guestLifetimeMs?: number;
  auth?: (body: Body) => Promise<Response> | Response;
  check?: (body: Body) => Promise<Response> | Response;
  register?: (body: Body) => Promise<Response> | Response;
} = {}) {
  const calls = { auth: [] as Body[], check: [] as Body[], register: [] as Body[], usage: [] as unknown[][] };
  const router = new TunnelRouter({ redis: options.redis });
  const proxyTunnels = new Set<string>();
  const proxy = {
    async createTunnel(id: string) { proxyTunnels.add(id); return { success: true, port: 23456 }; },
    setDbTunnelId() {}, hasTunnel(id: string) { return proxyTunnels.has(id); },
    async closeTunnel(id: string) { proxyTunnels.delete(id); },
  };
  const Handler = await loadWSHandler((async (url, init) => {
    const name = String(url).split("/").pop()!;
    const body = JSON.parse(String(init?.body));
    if (name === "auth") {
      calls.auth.push(body);
      return options.auth?.(body) ?? Response.json(body.token === "valid"
        ? { valid: true, organizationId: "org-a", userId: "user-a", plan: "free" }
        : { valid: false }, { status: body.token === "valid" ? 200 : 401 });
    }
    if (name === "check-subdomain") {
      calls.check.push(body);
      return options.check?.(body) ?? Response.json({ allowed: true, type: "available" });
    }
    if (name === "verify-ownership") return Response.json({ valid: true });
    if (name === "register") {
      calls.register.push(body);
      return options.register?.(body) ?? Response.json({ success: true, tunnelId: "db-a" });
    }
    throw new Error(`Unexpected API: ${url}`);
  }) as typeof fetch, async (...args) => { calls.usage.push(args); });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const handler = new Handler(wss, router, proxy as unknown as TCPProxy, proxy as unknown as UDPProxy);
  if (options.guestLifetimeMs !== undefined) {
    Reflect.set(handler, "guestLimits", new GuestTunnelLimits(options.redis, 120000, options.guestLifetimeMs));
  }
  await once(wss, "listening");
  const address = wss.address();
  assert.ok(address && typeof address !== "string");
  let disposed = false;
  const close = async () => {
    if (disposed) return;
    disposed = true;
    handler.shutdown();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await router.shutdown();
  };
  t.after(close);
  return { close, router, calls, proxyTunnels, async connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    ws.on("error", () => {});
    await once(ws, "open");
    return ws;
  } };
}
async function send(ws: WebSocket, value: Body) {
  const received = once(ws, "message");
  ws.send(JSON.stringify(value));
  return JSON.parse(String((await received)[0]));
}
const opening = { type: "open_tunnel", apiKey: "valid", protocol: "http", subdomain: "security-test" };

test("protected tunnel features reject missing credentials before allocation", { timeout: 5000 }, async t => {
  const f = await harness(t);
  for (const fields of [{ protocol: "tcp" }, { protocol: "udp" }, { customDomain: "preview.example.test" }, { password: "preview" }, { forceTakeover: true }]) {
    const ws = await f.connect();
    const closed = once(ws, "close");
    assert.equal((await send(ws, { type: "open_tunnel", ...fields })).code, "AUTH_REQUIRED");
    await closed;
  }
  assert.deepEqual(f.calls, { auth: [], check: [], register: [], usage: [] });
  assert.equal(f.proxyTunnels.size, 0);
});

test("empty and malformed supplied credentials never fall back to guest access", { timeout: 5000 }, async t => {
  const f = await harness(t);
  for (const apiKey of [null, "", "  ", false, 123, {}, [], "x".repeat(513)]) {
    const ws = await f.connect();
    const closed = once(ws, "close");
    assert.equal((await send(ws, { type: "open_tunnel", apiKey })).code, "AUTH_FAILED");
    await closed;
  }
  assert.deepEqual(f.calls, { auth: [], check: [], register: [], usage: [] });
});

test("invalid credentials, unsuccessful auth responses and organization-less identities fail closed", { timeout: 5000 }, async t => {
  for (const auth of [
    () => Response.json({ valid: false }),
    () => Response.json({ valid: true, organizationId: "org-a" }, { status: 503 }),
    () => Response.json({ valid: true }),
    () => Response.json({ valid: true, organizationId: " " }),
    () => Response.json({ valid: "yes", organizationId: "org-a" }),
    () => Response.json(null),
    () => { throw new Error("Auth service unavailable"); },
  ]) {
    const f = await harness(t, { auth });
    const ws = await f.connect();
    const closed = once(ws, "close");
    assert.equal((await send(ws, opening)).code, "AUTH_FAILED");
    await closed;
    assert.equal(f.calls.check.length + f.calls.register.length + f.calls.usage.length, 0);
  }
});

test("an authenticated tunnel is attributed, forwards traffic and disappears on disconnect", { timeout: 5000 }, async t => {
  const f = await harness(t);
  const ws = await f.connect();
  const opened = await send(ws, opening);
  assert.equal(opened.type, "tunnel_opened");
  assert.equal(f.calls.register[0].organizationId, "org-a");
  assert.equal(f.router.getTunnelMetadata(opened.tunnelId)?.dbTunnelId, "db-a");
  assert.equal(f.router.getTunnelMetadata(opened.tunnelId)?.expiresAt, undefined);
  const received = once(ws, "message");
  const forwarded = f.router.forwardRequest(opened.tunnelId, "GET", "/probe", {});
  const request = JSON.parse(String((await received)[0]));
  ws.send(JSON.stringify({ type: "response", requestId: request.requestId, status: 200, headers: {}, body: "owned" }));
  assert.equal((await forwarded).body, "owned");
  const closed = once(ws, "close"); ws.close(); await closed;
  await eventually(() => !f.router.hasTunnel(opened.tunnelId));
});

test("reserved subdomains belonging to another organization cannot be opened", { timeout: 5000 }, async t => {
  const f = await harness(t, { check: body => Response.json({ allowed: body.organizationId === "org-owner", error: "Subdomain already taken" }) });
  const ws = await f.connect();
  const closed = once(ws, "close");
  assert.equal((await send(ws, opening)).code, "SUBDOMAIN_DENIED");
  await closed;
  assert.equal(f.calls.register.length, 0);
});

test("repeated open requests cannot orphan the first tunnel", { timeout: 5000 }, async t => {
  const f = await harness(t);
  const ws = await f.connect();
  const opened = await send(ws, opening);
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ ...opening, subdomain: "orphan" }));
  await closed;
  await eventually(() => !f.router.hasTunnel(opened.tunnelId));
  assert.equal(f.calls.register.length, 1);
});

test("concurrent opens during authentication do not allocate a tunnel after the socket closes", { timeout: 5000 }, async t => {
  const auth = deferred<Response>();
  const f = await harness(t, { auth: () => auth.promise });
  const ws = await f.connect();
  const closed = once(ws, "close");
  ws.send(JSON.stringify(opening));
  ws.send(JSON.stringify(opening));
  await closed;
  auth.resolve(Response.json({ valid: true, organizationId: "org-a" }));
  await delay(10);
  assert.equal(f.calls.register.length, 0);
});

test("disconnect during registration releases partially allocated tunnel state", { timeout: 5000 }, async t => {
  const register = deferred<Response>();
  const f = await harness(t, { register: () => register.promise });
  const ws = await f.connect();
  ws.send(JSON.stringify(opening));
  await eventually(() => f.calls.register.length === 1);
  const tunnelId = new URL(f.calls.register[0].url).hostname;
  assert.ok(f.router.hasTunnel(tunnelId));
  const closed = once(ws, "close"); ws.terminate(); await closed;
  register.resolve(Response.json({ success: true, tunnelId: "db-a" }));
  await eventually(() => !f.router.hasTunnel(tunnelId));
});

test("registration failures release reservations and TCP/UDP listeners", { timeout: 5000 }, async t => {
  for (const protocol of ["http", "tcp", "udp"]) {
    const f = await harness(t, { register: () => Response.json({ error: "Quota reached" }, { status: 403 }) });
    const ws = await f.connect();
    const closed = once(ws, "close");
    assert.equal((await send(ws, { ...opening, protocol })).type, "error");
    await closed;
    await eventually(() => f.proxyTunnels.size === 0);
    const url = new URL(f.calls.register[0].url);
    await eventually(() => !f.router.hasTunnel(protocol === "http" ? url.hostname : url.hostname.split(".")[0]));
    assert.equal(f.calls.usage.length, 0);
  }
});

test("a deliberately bogus token is rejected before any public address is allocated", { timeout: 5000 }, async t => {
  const f = await harness(t);
  const ws = await f.connect();
  const closed = once(ws, "close");
  assert.equal((await send(ws, { ...opening, apiKey: "outray_invalid" })).code, "AUTH_FAILED");
  await closed;
  assert.equal(f.calls.auth.length, 1);
  assert.equal(f.calls.register.length, 0);
});

test("random names and the final fallback all undergo organization ownership checks", { timeout: 5000 }, async t => {
  const f = await harness(t, { check: () => Response.json({ allowed: false, error: "Reserved" }) });
  const ws = await f.connect();
  const closed = once(ws, "close");
  assert.equal((await send(ws, { ...opening, subdomain: null })).code, "TUNNEL_UNAVAILABLE");
  await closed;
  assert.equal(f.calls.check.length, 6);
  assert.ok(f.calls.check.every(body => body.organizationId === "org-a"));
  assert.equal(f.calls.register.length, 0);
});

test("authenticated TCP, UDP and custom-domain tunnels retain registration and disconnect cleanup", { timeout: 5000 }, async t => {
  for (const fields of [{ protocol: "tcp" }, { protocol: "udp" }, { customDomain: "preview.example.test" }]) {
    const f = await harness(t);
    const ws = await f.connect();
    const opened = await send(ws, { ...opening, ...fields });
    assert.equal(opened.type, "tunnel_opened");
    assert.equal(f.calls.register[0].organizationId, "org-a");
    assert.equal(f.router.getTunnelMetadata(opened.tunnelId)?.dbTunnelId, "db-a");
    const closed = once(ws, "close"); ws.close(); await closed;
    await eventually(() => !f.router.hasTunnel(opened.tunnelId) && f.proxyTunnels.size === 0);
  }
});

async function guestHarness(t: TestContext, options: Parameters<typeof harness>[1] = {}) {
  let fixture: Awaited<ReturnType<typeof harness>> | undefined;
  const redis = await isolatedRedis(t, async () => { await fixture?.close(); });
  if (!redis) return;
  fixture = await harness(t, { ...options, redis });
  return { ...fixture, redis };
}

test("auth-free HTTP tunnels serve traffic with a fixed 60-minute guest lease", { timeout: 5000 }, async t => {
  const f = await guestHarness(t); if (!f) return;
  const ws = await f.connect();
  const before = Date.now();
  const opened = await send(ws, { type: "open_tunnel", protocol: "http", subdomain: null, customDomain: null, organizationId: "forged-org", expiresAt: Number.MAX_SAFE_INTEGER });
  assert.equal(opened.type, "tunnel_opened");
  const metadata = f.router.getTunnelMetadata(opened.tunnelId)!;
  assert.equal(metadata.organizationId, undefined);
  assert.equal(metadata.dbTunnelId, undefined);
  assert.ok(metadata.expiresAt! >= before + GUEST_LIFETIME_MS - 100);
  assert.ok(metadata.expiresAt! <= Date.now() + GUEST_LIFETIME_MS);
  assert.equal(f.calls.auth.length + f.calls.register.length + f.calls.usage.length, 0);
  const received = once(ws, "message");
  const forwarded = f.router.forwardRequest(opened.tunnelId, "GET", "/guest", {});
  const request = JSON.parse(String((await received)[0]));
  ws.send(JSON.stringify({ type: "response", requestId: request.requestId, statusCode: 200, headers: {}, body: "guest-content" }));
  assert.equal((await forwarded).body, "guest-content");
  const closed = once(ws, "close"); ws.close(); await closed;
  await eventually(() => !f.router.hasTunnel(opened.tunnelId));
  // Redis commands after the close handler's compare-and-delete see the released slot.
  assert.equal(await f.redis.get(metadata.guestLeaseKey!), null);
});

test("guest expiry closes the socket and removes routing and admission state", { timeout: 5000 }, async t => {
  const f = await guestHarness(t, { guestLifetimeMs: 500 }); if (!f) return;
  const ws = await f.connect();
  const opened = await send(ws, { type: "open_tunnel" });
  const metadata = f.router.getTunnelMetadata(opened.tunnelId)!;
  const expired = once(ws, "message"), closed = once(ws, "close");
  const error = JSON.parse(String((await expired)[0]));
  assert.equal(error.code, "TUNNEL_EXPIRED");
  await closed;
  assert.equal(f.router.hasTunnel(opened.tunnelId), false);
  assert.equal(await f.redis.exists(`tunnel:online:${opened.tunnelId}`, metadata.guestLeaseKey!), 0);
  await assert.rejects(f.router.forwardRequest(opened.tunnelId, "GET", "/", {}), /not available/);
});

test("a guest cannot claim a reserved address or retain a slot after denial", { timeout: 5000 }, async t => {
  const f = await guestHarness(t, { check: () => Response.json({ allowed: false, code: "AUTH_REQUIRED", error: "Authentication required for reserved subdomains" }) });
  if (!f) return;
  const ws = await f.connect();
  const closed = once(ws, "close");
  assert.equal((await send(ws, { type: "open_tunnel", subdomain: "reserved", organizationId: "org-owner" })).code, "AUTH_REQUIRED");
  await closed;
  assert.equal(f.calls.check[0].organizationId, undefined);
  assert.deepEqual(await f.redis.keys("tunnel:guest:active:*"), []);
  assert.equal(f.calls.register.length, 0);
});

test("guest concurrent and rolling start limits are enforced through WebSockets", { timeout: 5000 }, async t => {
  const f = await guestHarness(t); if (!f) return;
  const first = await f.connect();
  assert.equal((await send(first, { type: "open_tunnel" })).type, "tunnel_opened");
  const second = await f.connect();
  const denied = once(second, "close");
  assert.equal((await send(second, { type: "open_tunnel" })).code, "RATE_LIMITED");
  await denied;
  const firstClosed = once(first, "close"); first.close(); await firstClosed;
  for (let i = 1; i < 5; i++) {
    const ws = await f.connect();
    assert.equal((await send(ws, { type: "open_tunnel" })).type, "tunnel_opened");
    const closed = once(ws, "close"); ws.close(); await closed;
  }
  const sixth = await f.connect();
  const closed = once(sixth, "close");
  assert.equal((await send(sixth, { type: "open_tunnel" })).code, "RATE_LIMITED");
  await closed;
});

test("guest admission fails closed when Redis limits are unavailable", { timeout: 5000 }, async t => {
  const f = await harness(t);
  const ws = await f.connect();
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ type: "open_tunnel" }));
  const [code] = await closed;
  assert.equal(code, 1011);
  assert.equal(f.calls.check.length + f.calls.register.length, 0);
});

test("guests can choose unreserved HTTP addresses but cannot answer another tunnel's requests", { timeout: 5000 }, async t => {
  const f = await guestHarness(t); if (!f) return;
  const guest = await f.connect();
  const opened = await send(guest, { type: "open_tunnel", subdomain: "temporary" });
  assert.equal(opened.type, "tunnel_opened");
  const owner = await f.connect();
  const account = await send(owner, opening);
  assert.equal(account.type, "tunnel_opened", "Account tunnels bypass guest-only limits at the same IP");
  const received = once(owner, "message");
  let resolved = false;
  const response = f.router.forwardRequest(account.tunnelId, "GET", "/private", {}).then(value => { resolved = true; return value; });
  const request = JSON.parse(String((await received)[0]));
  guest.send(JSON.stringify({ type: "response", requestId: request.requestId, statusCode: 200, headers: {}, body: "forged" }));
  await delay(10);
  assert.equal(resolved, false);
  owner.send(JSON.stringify({ type: "response", requestId: request.requestId, statusCode: 200, headers: {}, body: "owner" }));
  assert.equal((await response).body, "owner");
});

test("an unsupported protocol cannot silently become guest HTTP", { timeout: 5000 }, async t => {
  const f = await harness(t);
  const ws = await f.connect();
  const closed = once(ws, "close");
  assert.equal((await send(ws, { type: "open_tunnel", protocol: "other" })).code, "INVALID_PROTOCOL");
  await closed;
  assert.equal(f.calls.check.length, 0);
});

test("guest fallback names remain DNS-valid and undergo the same reservation check", { timeout: 5000 }, async t => {
  let checks = 0;
  const f = await guestHarness(t, { check: body => {
    assert.match(body.subdomain, /^[a-z0-9-]{1,63}$/);
    return Response.json({ allowed: ++checks === 6, type: "available" });
  } });
  if (!f) return;
  const ws = await f.connect();
  const opened = await send(ws, { type: "open_tunnel" });
  assert.equal(opened.type, "tunnel_opened");
  assert.equal(checks, 6);
  assert.match(new URL(opened.url).hostname, /^tunnel-/);
});
