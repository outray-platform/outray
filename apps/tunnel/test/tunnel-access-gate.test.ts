import assert from "node:assert/strict";
import test from "node:test";
import { accessFixture, CONSOLE, navigate } from "./helpers/access-fixture";

const HOST = "app.example.test";

test("unauthenticated navigations redirect to console sign-in with the original path", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  const response = await f.send(HOST, "/reports?tab=open", navigate);
  assert.equal(response.status, 302);
  const location = new URL(String(response.headers.location));
  assert.equal(location.origin, CONSOLE);
  assert.equal(location.pathname, "/tunnel-auth");
  assert.equal(location.searchParams.get("host"), HOST);
  assert.equal(location.searchParams.get("return"), "/reports?tab=open");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(f.received.length, 0);
});

test("non-navigation requests get 401 without a redirect", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  for (const [headers, method] of [
    [{ "sec-fetch-mode": "cors", accept: "text/html" }, "GET"],
    [{ accept: "application/json" }, "GET"],
    [navigate, "POST"],
    [{}, "GET"],
  ] as const) {
    const response = await f.send(HOST, "/api/data", headers, method);
    assert.equal(response.status, 401);
    assert.equal(response.headers.location, undefined);
  }
  assert.equal(f.received.length, 0);
});

test("the callback redeems once, sets a host-only cookie and returns to the original path", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  const { response, cookie } = await f.signIn(HOST, "/reports?tab=open");
  assert.equal(response.headers.location, "/reports?tab=open");
  const setCookie = String(response.headers["set-cookie"]?.[0]);
  assert.match(setCookie, /^__Host-outray_access=v1\./);
  for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(setCookie.includes(attribute), attribute);
  assert.doesNotMatch(setCookie, /Domain=/i);
  assert.deepEqual(f.console.calls.map(call => [call.path, call.authorization]), [["/tunnel/access/redeem", "Bearer edge-secret"]]);
  assert.equal(f.console.calls[0].body.host, HOST);

  const page = await f.send(HOST, "/reports", { ...navigate, cookie: `theme=dark; ${cookie}; other=1` });
  assert.equal(page.status, 200);
  assert.equal(page.body, "app:/reports");
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].headers.cookie, "theme=dark; other=1");
  const alone = await f.send(HOST, "/x", { cookie });
  assert.equal(alone.status, 200);
  assert.equal(f.received[1].headers.cookie, undefined);
  assert.ok(f.received.every(request => !request.path.startsWith("/_outray")));
});

test("callback codes cannot be replayed", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  const code = f.console.issue(HOST, "/");
  assert.equal((await f.send(HOST, `/_outray/callback?code=${code}`, navigate)).status, 302);
  const replay = await f.send(HOST, `/_outray/callback?code=${code}`, navigate);
  assert.equal(replay.status, 403);
  assert.equal(replay.headers["set-cookie"], undefined);
});

test("codes and cookies are bound to the host they were issued for", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  await f.tunnel("other.example.test");
  const code = f.console.issue(HOST, "/");
  const wrongHost = await f.send("other.example.test", `/_outray/callback?code=${code}`, navigate);
  assert.equal(wrongHost.status, 403);
  assert.equal(f.console.calls.at(-1)?.body.host, "other.example.test");

  const { cookie } = await f.signIn(HOST);
  const elsewhere = await f.send("other.example.test", "/", { ...navigate, cookie });
  assert.equal(elsewhere.status, 302);
  assert.match(String(elsewhere.headers.location), /^https:\/\/console\.example\.test\/tunnel-auth/);
  assert.equal(f.received.length, 0);
});

test("a code redeemed for another organization's identity is refused", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  f.console.members.add("org-b:user-a");
  const code = f.console.issue(HOST, "/", "user-a", "org-b");
  assert.equal((await f.send(HOST, `/_outray/callback?code=${code}`, navigate)).status, 403);
});

test("post-login and pre-login destinations cannot leave the tunnel host", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  for (const returnPath of ["https://evil.test/", "//evil.test", "/\\evil.test", "/%2F%2Fevil.test", "/_outray/callback?code=x"]) {
    const { response } = await f.signIn(HOST, returnPath);
    assert.equal(response.headers.location, "/", returnPath);
  }
  for (const path of ["//evil.test/", "/\\evil.test"]) {
    const redirect = await f.send(HOST, path, navigate);
    assert.equal(new URL(String(redirect.headers.location)).searchParams.get("return"), "/", path);
  }
});

test("malformed callback requests never reach the console", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST);
  for (const path of ["/_outray/callback", "/_outray/callback?code=short", `/_outray/callback?code=${"*".repeat(43)}`]) {
    assert.equal((await f.send(HOST, path, navigate)).status, 400);
  }
  for (const method of ["POST", "HEAD"]) {
    assert.equal((await f.send(HOST, `/_outray/callback?code=${"a".repeat(43)}`, {}, method)).status, 405, method);
  }
  assert.equal(f.console.calls.length, 0);
});

test("tampered and expired cookies are rejected and cleared", { timeout: 5000 }, async t => {
  const f = await accessFixture(t, { sessionMs: 60_000, revalidateMs: 120_000 });
  await f.tunnel(HOST);
  const { cookie } = await f.signIn(HOST);
  const [name, value] = cookie.split("=");
  const [version, payload, signature] = value.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...claims, u: "user-b" })).toString("base64url");
  for (const candidate of [`${name}=${version}.${forged}.${signature}`, `${name}=${version}.${payload}.${signature.slice(1)}x`, `${name}=garbage`]) {
    const response = await f.send(HOST, "/", { ...navigate, cookie: candidate });
    assert.equal(response.status, 302);
    assert.match(String(response.headers["set-cookie"]), /Max-Age=0/);
  }
  assert.equal((await f.send(HOST, "/", { cookie })).status, 200);
  f.advance(60_001);
  assert.equal((await f.send(HOST, "/", { cookie })).status, 401);
});

test("removed members lose access once the revalidation window passes", { timeout: 5000 }, async t => {
  const f = await accessFixture(t, { revalidateMs: 300_000 });
  await f.tunnel(HOST);
  const { cookie } = await f.signIn(HOST);
  f.console.members.clear();
  f.advance(299_000);
  assert.equal((await f.send(HOST, "/", { cookie })).status, 200, "cached grant within the window");
  f.advance(2_000);
  const revoked = await f.send(HOST, "/", { ...navigate, cookie });
  assert.equal(revoked.status, 302);
  assert.match(String(revoked.headers["set-cookie"]), /Max-Age=0/);
  assert.equal(f.console.calls.at(-1)?.path, "/tunnel/access/revalidate");
  assert.equal((await f.send(HOST, "/", { cookie })).status, 401);
});

test("console outages fail closed for callbacks and revalidation", { timeout: 5000 }, async t => {
  const f = await accessFixture(t, { revalidateMs: 1_000 });
  await f.tunnel(HOST);
  const { cookie } = await f.signIn(HOST);
  f.console.down = true;
  f.advance(1_001);
  const page = await f.send(HOST, "/", { ...navigate, cookie });
  assert.equal(page.status, 503);
  assert.equal(page.headers.location, undefined);
  assert.equal((await f.send(HOST, `/_outray/callback?code=${"a".repeat(43)}`, navigate)).status, 503);
  assert.equal(f.received.length, 0);
  f.console.down = false;
  assert.equal((await f.send(HOST, "/", { cookie })).status, 200);
});

test("bypass prefixes serve machine callers without sign-in but nothing else", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST, { accessBypass: ["/webhooks"] });
  assert.equal((await f.send(HOST, "/webhooks/stripe", {}, "POST")).status, 200);
  for (const path of ["/webhooks/../admin", "/webhooks/%2e%2e/admin", "/webhooksx", "/admin"]) {
    assert.equal((await f.send(HOST, path, {}, "POST")).status, 401, path);
  }
  assert.deepEqual(f.received.map(request => request.path), ["/webhooks/stripe"]);
});

test("an edge without console configuration refuses organization tunnels", { timeout: 5000 }, async t => {
  const f = await accessFixture(t, { consoleUrl: undefined });
  await f.tunnel(HOST);
  assert.equal(f.gate.configured, false);
  assert.equal((await f.send(HOST, "/", navigate)).status, 503);
  assert.equal(f.received.length, 0);
});

test("public and password tunnels never intercept the callback path", { timeout: 5000 }, async t => {
  const f = await accessFixture(t);
  await f.tunnel(HOST, { access: "public" });
  const response = await f.send(HOST, "/_outray/callback?code=abc", navigate);
  assert.equal(response.status, 200);
  assert.equal(response.body, "app:/_outray/callback?code=abc");
  assert.equal(f.console.calls.length, 0);
});
