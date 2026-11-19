import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { accessFixture, navigate } from "./helpers/access-fixture";

const HOST = "app.example.test";

test("WebSocket upgrades to organization tunnels require a valid access cookie and are never redirected", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  assert.equal(await f.upgrade(HOST, "/socket", navigate), 401);
  assert.equal(await f.upgrade(HOST, "/socket", { cookie: "__Host-outray_access=v1.bad.sig" }), 401);
  assert.equal(f.upgrades.length, 0);

  const { cookie } = await f.signIn(HOST);
  const ws = await f.upgrade(HOST, "/socket", { cookie: `${cookie}; theme=dark` });
  assert.ok(ws instanceof WebSocket);
  assert.equal(f.upgrades.length, 1);
  assert.equal(f.upgrades[0].headers.cookie, "theme=dark");
});

test("WebSocket access cookies are host-bound and bypass prefixes apply to upgrades", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST, { accessBypass: ["/hooks"] });
  await f.tunnel("other.example.test");
  const { cookie } = await f.signIn(HOST);
  assert.equal(await f.upgrade("other.example.test", "/socket", { cookie }), 401);
  assert.ok(await f.upgrade(HOST, "/hooks/live") instanceof WebSocket);
  assert.equal(await f.upgrade(HOST, "/hooks/../socket"), 401);
});

test("WebSocket upgrades fail closed when the console cannot revalidate", { timeout: 5000 }, async t => {
  const f = await accessFixture(t, { revalidateMs: 1_000 });
  await f.tunnel(HOST);
  const { cookie } = await f.signIn(HOST);
  f.console.down = true;
  f.advance(1_001);
  assert.equal(await f.upgrade(HOST, "/socket", { cookie }), 503);
  assert.equal(f.upgrades.length, 0);
});

test("open WebSockets close when membership is revoked", { timeout: 5000 }, async t => {
  const f = await accessFixture(t, { revalidateMs: 1_000 });
  await f.tunnel(HOST);
  const { cookie } = await f.signIn(HOST);
  const ws = await f.upgrade(HOST, "/socket", { cookie });
  assert.ok(ws instanceof WebSocket);
  await f.wsProxy.recheckAccess();
  assert.equal(ws.readyState, WebSocket.OPEN, "a current member stays connected");
  f.console.members.clear();
  f.advance(1_001);
  const closed = once(ws, "close");
  await f.wsProxy.recheckAccess();
  const [code] = await closed;
  assert.equal(code, 1008);
});

test("sockets opened while a tunnel was public close when it becomes organization-only, except bypass paths", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST, { access: "public", dbTunnelId: "db-a" });
  const open = await f.upgrade(HOST, "/socket");
  const hook = await f.upgrade(HOST, "/hooks/live");
  assert.ok(open instanceof WebSocket && hook instanceof WebSocket);
  f.router.getTunnelMetadata(HOST)!.accessBypass = ["/hooks"];
  f.router.getTunnelMetadata(HOST)!.access = "organization";
  const closed = once(open, "close");
  await f.wsProxy.recheckAccess(HOST);
  assert.equal((await closed)[0], 1008);
  assert.equal(hook.readyState, WebSocket.OPEN);
});
