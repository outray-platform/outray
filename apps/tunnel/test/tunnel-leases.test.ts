import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { TunnelRouter } from "../src/core/TunnelRouter";
import { withTunnelReservationLock, TunnelReservationBusyError } from "../../../shared/tunnel-reservation-lock";
import { isolatedRedis } from "./helpers/redis";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  terminated = false;
  terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit("close"); }
  send() {}
}
async function setup(t: import("node:test").TestContext) {
  const routers: TunnelRouter[] = [];
  const redis = await isolatedRedis(t, async () => { for (const router of routers) await router.shutdown(); });
  return { redis, createRouter() { const router = new TunnelRouter({ redis }); routers.push(router); return router; } };
}

const ws = (socket: Socket) => socket as unknown as WebSocket;
const metadata = { organizationId: "org-a", userId: "user-a", dbTunnelId: "db-a" };
const hostname = "test.example.test";
const routeKey = `tunnel:online:${hostname}`;
const onlineKey = "org:org-a:online_tunnels";
const lastSeenKey = "tunnel:last_seen:db-a";
const refresh = (router: TunnelRouter) => (router as unknown as { refreshActiveTunnels(): Promise<void> }).refreshActiveTunnels();

test("closed sockets are reaped instead of refreshing their routing and online leases", { timeout: 5000 }, async t => {
  const { redis, createRouter } = await setup(t); if (!redis) return;
  const router = createRouter();
  const socket = new Socket();
  assert.ok(await router.reserveTunnel(hostname, ws(socket), metadata));
  await redis.set(lastSeenKey, "1");
  await refresh(router);
  assert.ok(Number(await redis.get(lastSeenKey)) > 1);
  socket.readyState = WebSocket.CLOSED; // Missed close event, e.g. legacy orphan.
  await refresh(router);
  assert.equal(router.hasTunnel(hostname), false);
  assert.equal(await redis.exists(routeKey, lastSeenKey), 0);
  assert.equal(await redis.scard(onlineKey), 0);
  assert.equal(await redis.scard("global:orgs_with_online_tunnels"), 0);
  assert.ok(socket.terminated);
});

test("closing sockets and explicit stop commands release their status immediately", { timeout: 5000 }, async t => {
  const { redis, createRouter } = await setup(t); if (!redis) return;
  const router = createRouter();
  const socket = new Socket();
  assert.ok(await router.reserveTunnel(hostname, ws(socket), metadata));
  socket.readyState = WebSocket.CLOSING;
  await refresh(router);
  assert.equal(await redis.exists(routeKey, lastSeenKey), 0);
  const replacement = new Socket();
  assert.ok(await router.reserveTunnel(hostname, ws(replacement), metadata));
  (router as unknown as { handleControlMessage(message: string): void }).handleControlMessage(`kill:${hostname}`);
  assert.ok(replacement.terminated);
  assert.equal(router.hasTunnel(hostname), false);
  // Read after the atomic release already sent by handleControlMessage.
  assert.equal(await redis.exists(routeKey, lastSeenKey), 0);
});

test("late close and heartbeat from another edge cannot delete or revive a replaced tunnel", { timeout: 5000 }, async t => {
  const { redis, createRouter } = await setup(t); if (!redis) return;
  const old = createRouter(), current = createRouter();
  const first = new Socket(), second = new Socket();
  assert.ok(await old.reserveTunnel(hostname, ws(first), metadata));
  assert.equal(await current.reserveTunnel(hostname, ws(second), metadata), false, "A different edge does not imply the tunnel is offline");
  assert.ok(await current.reserveTunnel(hostname, ws(second), metadata, true));
  const replacement = await redis.get(routeKey);
  await old.unregisterTunnel(hostname, ws(first));
  assert.equal(await redis.get(routeKey), replacement);
  assert.equal(await redis.sismember(onlineKey, "db-a"), 1);
  assert.ok(await redis.get(lastSeenKey));
  assert.equal(await old.reserveTunnel(hostname, ws(first), { ...metadata, organizationId: "org-b" }, true), false);
  assert.equal(await redis.get(routeKey), replacement);
});

test("a superseded edge's heartbeat detects lost ownership and drops its local socket", { timeout: 5000 }, async t => {
  const { redis, createRouter } = await setup(t); if (!redis) return;
  const old = createRouter(), current = createRouter();
  const first = new Socket(), second = new Socket();
  await old.reserveTunnel(hostname, ws(first), metadata);
  await current.reserveTunnel(hostname, ws(second), metadata, true);
  const replacement = await redis.get(routeKey);
  await refresh(old);
  assert.ok(first.terminated);
  assert.equal(old.hasTunnel(hostname), false);
  assert.equal(await redis.get(routeKey), replacement);
  assert.equal(await redis.sismember(onlineKey, "db-a"), 1);
});

test("an expired or released lease is never recreated by a heartbeat", { timeout: 5000 }, async t => {
  const { redis, createRouter } = await setup(t); if (!redis) return;
  const router = createRouter();
  const socket = new Socket();
  await router.reserveTunnel(hostname, ws(socket), metadata);
  await redis.del(routeKey);
  await refresh(router);
  assert.equal(await redis.exists(routeKey, lastSeenKey), 0);
  assert.equal(await redis.scard(onlineKey), 0);
  assert.ok(socket.terminated);
});

test("a client disconnecting during database registration releases the newly added quota slot", { timeout: 5000 }, async t => {
  const { redis, createRouter } = await setup(t); if (!redis) return;
  const router = createRouter();
  const socket = new Socket();
  await router.reserveTunnel(hostname, ws(socket), { organizationId: "org-a" });
  // The control plane adds capacity before returning the database ID.
  await redis.sadd(onlineKey, "db-a");
  socket.readyState = WebSocket.CLOSED;
  assert.equal(await router.registerTunnel(hostname, ws(socket), metadata), false);
  assert.equal(await redis.exists(routeKey, lastSeenKey), 0);
  assert.equal(await redis.scard(onlineKey), 0);
});

test("console reservations and tunnel allocations share an exclusive hostname lock", { timeout: 5000 }, async t => {
  const { redis, createRouter } = await setup(t); if (!redis) return;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const first = withTunnelReservationLock(redis, hostname, async () => { entered(); await pending; });
  await acquired;
  await assert.rejects(withTunnelReservationLock(redis, hostname, async () => assert.fail("Must not enter concurrently")), TunnelReservationBusyError);
  await withTunnelReservationLock(redis, "other.example.test", async () => {});
  finish(); await first;
  await assert.rejects(withTunnelReservationLock(redis, hostname, async () => { throw new Error("Database failure"); }), /Database failure/);
  await withTunnelReservationLock(redis, hostname, async () => {});
  await assert.rejects(withTunnelReservationLock(redis, hostname, async () => {
    // Simulate expiration and reacquisition: a delayed release must preserve it.
    await redis.set(`tunnel:reservation_lock:${hostname}`, "replacement", "PX", 30000);
  }), TunnelReservationBusyError);
  assert.equal(await redis.get(`tunnel:reservation_lock:${hostname}`), "replacement");
});

test("a registration reply arriving after stop cannot leave a quota slot behind", { timeout: 5000 }, async t => {
  const { redis, createRouter } = await setup(t); if (!redis) return;
  const router = createRouter();
  const socket = new Socket();
  await router.reserveTunnel(hostname, ws(socket), { organizationId: "org-a" });
  await router.unregisterTunnel(hostname, ws(socket));
  socket.readyState = WebSocket.CLOSED;
  await redis.sadd(onlineKey, "db-a");
  assert.equal(await router.registerTunnel(hostname, ws(socket), metadata), false);
  assert.equal(await redis.scard(onlineKey), 0);
  assert.equal(await redis.exists(routeKey, lastSeenKey), 0);
});
