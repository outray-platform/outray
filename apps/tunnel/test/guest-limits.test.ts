import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { GuestTunnelLimits, guestClientIp, GUEST_LIFETIME_MS } from "../src/lib/guest-tunnels";
import { TunnelRouter } from "../src/core/TunnelRouter";
import { WSProxy } from "../src/core/WSProxy";
import { isolatedRedis } from "./helpers/redis";

function request(peer: string, headers: Record<string, string> = {}) {
  return { socket: { remoteAddress: peer }, headers } as unknown as IncomingMessage;
}

test("guest identity ignores untrusted headers and normalizes equivalent IP addresses", () => {
  const forged = { "x-forwarded-for": "192.0.2.99", "cf-connecting-ip": "192.0.2.100", "x-real-ip": "192.0.2.101" };
  assert.equal(guestClientIp(request("203.0.113.10", forged), ["127.0.0.1"]), "203.0.113.10");
  assert.equal(guestClientIp(request("::ffff:203.0.113.10", forged), []), "203.0.113.10");
  assert.equal(guestClientIp(request("2001:0DB8:0000:0000:0000:0000:0000:0001"), []), "2001:db8::1");
  assert.equal(guestClientIp(request("127.0.0.1", { "x-forwarded-for": "192.0.2.99, 203.0.113.10" }), ["127.0.0.1"]), "203.0.113.10");
  assert.equal(guestClientIp(request("127.0.0.1", { "x-forwarded-for": "invalid" }), ["127.0.0.1"]), "127.0.0.1");
  assert.equal(guestClientIp(request(""), []), undefined);
});

test("25 concurrent guest admissions across edges cannot exceed one active tunnel per IP", async t => {
  const redis = await isolatedRedis(t); if (!redis) return;
  const edges = [new GuestTunnelLimits(redis), new GuestTunnelLimits(redis)];
  const before = Date.now();
  const leases = await Promise.all(Array.from({ length: 25 }, (_, i) => edges[i % 2].admit("203.0.113.10")));
  const accepted = leases.filter(lease => lease !== undefined);
  assert.equal(accepted.length, 1);
  assert.ok(accepted[0].expiresAt >= before + GUEST_LIFETIME_MS - 100);
  assert.ok(accepted[0].expiresAt <= Date.now() + GUEST_LIFETIME_MS);
  assert.ok(await edges[1].admit("203.0.113.11"), "A different IP gets independent capacity");
});

test("closing a tunnel frees concurrency but cannot reset the five-start sliding window", async t => {
  const redis = await isolatedRedis(t); if (!redis) return;
  const first = new GuestTunnelLimits(redis), second = new GuestTunnelLimits(redis);
  let startsKey = "";
  for (let i = 0; i < 5; i++) {
    const lease = await (i % 2 ? first : second).admit("203.0.113.10");
    assert.ok(lease);
    startsKey = lease.guestLeaseKey.replace(":active:", ":starts:");
    await first.release(lease);
  }
  assert.equal(await second.admit("203.0.113.10"), undefined);
  const ids = await redis.zrange(startsKey, 0, -1);
  for (const id of ids) await redis.zadd(startsKey, Date.now() - 61000, id);
  assert.ok(await second.admit("203.0.113.10"), "Starts become available as the sliding window expires");
});

test("delayed release and lost edges cannot hold capacity or delete a replacement guest lease", async t => {
  const redis = await isolatedRedis(t); if (!redis) return;
  const limits = new GuestTunnelLimits(redis, 60);
  const first = await limits.admit("203.0.113.10"); assert.ok(first);
  await delay(80);
  const replacement = await limits.admit("203.0.113.10"); assert.ok(replacement);
  await limits.release(first);
  assert.equal(await redis.get(replacement.guestLeaseKey), replacement.guestSessionId);
});

test("guest limits fail closed if their shared Redis state is unavailable", async () => {
  await assert.rejects(new GuestTunnelLimits(undefined).admit("203.0.113.10"), /unavailable/);
});

test("heartbeats cannot extend a guest deadline and released or expired guests cannot reclaim routes", async t => {
  let router: TunnelRouter | undefined;
  const redis = await isolatedRedis(t, async () => { await router?.shutdown(); }); if (!redis) return;
  router = new TunnelRouter({ redis });
  const limits = new GuestTunnelLimits(redis, 120000, 300);
  const lease = await limits.admit("203.0.113.10"); assert.ok(lease);
  const socket = { readyState: WebSocket.OPEN as number, send() {}, close() { this.readyState = WebSocket.CLOSED; }, terminate() { this.readyState = WebSocket.CLOSED; } } as unknown as WebSocket;
  const hostname = "guest.example.test";
  assert.ok(await router.reserveTunnel(hostname, socket, lease));
  const state = JSON.parse((await redis.get(`tunnel:online:${hostname}`))!);
  assert.equal(state.expiresAt, lease.expiresAt);
  await delay(50);
  await (router as unknown as { refreshActiveTunnels(): Promise<void> }).refreshActiveTunnels();
  assert.equal(JSON.parse((await redis.get(`tunnel:online:${hostname}`))!).expiresAt, lease.expiresAt);
  assert.ok(await redis.pttl(`tunnel:online:${hostname}`) <= lease.expiresAt - Date.now() + 10);
  await delay(320);
  assert.equal(router.hasTunnel(hostname), false);
  assert.equal(await redis.exists(`tunnel:online:${hostname}`, lease.guestLeaseKey), 0);
  socket.readyState = WebSocket.OPEN;
  assert.equal(await router.reserveTunnel(hostname, socket, lease), false);
  await assert.rejects(router.forwardRequest(hostname, "GET", "/", {}), /not available/);
});

test("cleanup of expired WebSocket forwarding closes only that connection owner's sockets", () => {
  const proxy = new WSProxy(new TunnelRouter());
  const first = { terminate() { this.closed = true; }, closed: false };
  const second = { terminate() { this.closed = true; }, closed: false };
  const oldControl = {}, newControl = {};
  Reflect.get(proxy, "activeConnections").set("first", first).set("second", second);
  Reflect.get(proxy, "connectionOwners").set("first", { tunnelId: "same.example.test", controlWs: oldControl }).set("second", { tunnelId: "same.example.test", controlWs: newControl });
  proxy.cleanupTunnel("same.example.test", oldControl as WebSocket);
  assert.ok(first.closed);
  assert.equal(second.closed, false);
  assert.equal(Reflect.get(proxy, "activeConnections").has("second"), true);
});

test("another control socket cannot inject or close a guest WebSocket stream", () => {
  const proxy = new WSProxy(new TunnelRouter());
  const owner = {}, attacker = {};
  const delivered: string[] = [];
  let closed = false;
  const stream = { readyState: WebSocket.OPEN, send(data: Buffer) { delivered.push(data.toString()); }, close() { closed = true; } };
  Reflect.get(proxy, "activeConnections").set("stream", stream);
  Reflect.get(proxy, "connectionOwners").set("stream", { tunnelId: "guest.example.test", controlWs: owner });
  const frame = { type: "ws_frame" as const, wsConnectionId: "stream", data: Buffer.from("content").toString("base64"), isBinary: false };
  proxy.handleFrame(frame, attacker as WebSocket);
  proxy.handleClose({ type: "ws_close", wsConnectionId: "stream" }, attacker as WebSocket);
  assert.deepEqual(delivered, []);
  assert.equal(closed, false);
  proxy.handleFrame(frame, owner as WebSocket);
  assert.deepEqual(delivered, ["content"]);
});

test("a replaced control socket cannot answer HTTP requests for its old address", async () => {
  const router = new TunnelRouter();
  const first = { readyState: WebSocket.OPEN as number, send() {}, terminate() { this.readyState = WebSocket.CLOSED; } } as unknown as WebSocket;
  let requestId = "";
  const current = { readyState: WebSocket.OPEN, send(data: string) { requestId = JSON.parse(data).requestId; }, terminate() {} } as unknown as WebSocket;
  const metadata = { userId: "same-user", organizationId: "same-org" };
  const hostname = "replace.example.test";
  await router.reserveTunnel(hostname, first, metadata);
  await router.reserveTunnel(hostname, current, metadata, true);
  const pending = router.forwardRequest(hostname, "GET", "/", {});
  const response = { type: "response" as const, requestId, statusCode: 200, headers: {}, body: "old-socket" };
  router.handleMessage(hostname, response, first);
  assert.ok(Reflect.get(router, "pendingRequests").has(requestId));
  router.handleMessage(hostname, { ...response, body: "current-socket" }, current);
  assert.equal((await pending).body, "current-socket");
  await router.shutdown();
});
