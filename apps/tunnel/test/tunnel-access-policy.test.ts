import assert from "node:assert/strict";
import test from "node:test";
import { matchesBypass, normalizeBypassPrefix, resolveTunnelAccess, safeReturnPath } from "../src/lib/tunnel-access-policy";

test("bypass prefixes must be plain absolute paths outside the reserved namespace", () => {
  assert.equal(normalizeBypassPrefix("/webhooks"), "/webhooks");
  assert.equal(normalizeBypassPrefix("/webhooks/stripe/"), "/webhooks/stripe");
  for (const value of ["", "/", "//", "webhooks", "/a/../b", "/./a", "/a//b", "/a?b", "/a#b", "/a%2fb", "/a\\b", "/a b", "/_outray", "/_outray/callback", "/x".repeat(70), 1, null]) {
    assert.equal(normalizeBypassPrefix(value), undefined, String(value));
  }
});

test("bypass matching respects segment boundaries and refuses ambiguous paths", () => {
  const prefixes = ["/webhooks"];
  for (const url of ["/webhooks", "/webhooks/", "/webhooks/stripe", "/webhooks?x=1", "/webhooks/a%20b"]) {
    assert.equal(matchesBypass(url, prefixes), true, url);
  }
  for (const url of ["/webhooksx", "/", "/admin", "/webhooks/../admin", "/webhooks/%2e%2e/admin", "/webhooks%2f..%2fadmin",
    "/webhooks/..%2Fadmin", "/webhooks\\..\\admin", "//webhooks", "/webhooks//x", "http://evil/webhooks", "/WEBHOOKS"]) {
    assert.equal(matchesBypass(url, prefixes), false, url);
  }
  assert.equal(matchesBypass("/webhooks", undefined), false);
});

test("return paths stay on the tunnel host", () => {
  for (const value of ["/", "/dashboard?tab=1", "/a/b#c"]) assert.equal(safeReturnPath(value), value);
  for (const value of ["https://evil.test/", "//evil.test", "/\\evil.test", "/%2fevil.test", "/%5Cevil.test", "evil", "",
    "/a\nb", "/ok\t", "/_outray/callback?code=x", "/_outray/anything", "/" + "a".repeat(2048), undefined, 5]) {
    assert.equal(safeReturnPath(value), undefined, String(value));
  }
});

test("access resolution defaults from passwords and rejects inconsistent requests", () => {
  const paid = { authenticated: true, protocol: "http", plan: "pro" };
  assert.deepEqual(resolveTunnelAccess({}, paid), { ok: true, access: "public" });
  assert.deepEqual(resolveTunnelAccess({ password: "x" }, paid), { ok: true, access: "password" });
  assert.deepEqual(resolveTunnelAccess({ access: "organization", accessBypass: ["/a", "/a/"] }, paid), { ok: true, access: "organization", accessBypass: ["/a"] });
  assert.equal((resolveTunnelAccess({ access: "password" }, paid) as { code: string }).code, "INVALID_ACCESS");
  assert.equal((resolveTunnelAccess({ access: "public", password: "x" }, paid) as { code: string }).code, "INVALID_ACCESS");
  assert.equal((resolveTunnelAccess({ access: "organization", accessBypass: Array.from({ length: 11 }, (_, i) => `/p${i}`) }, paid) as { code: string }).code, "INVALID_ACCESS");
  assert.equal((resolveTunnelAccess({ access: "organization" }, { ...paid, authenticated: false }) as { code: string }).code, "AUTH_REQUIRED");
  assert.equal((resolveTunnelAccess({ access: "organization" }, { ...paid, plan: undefined }) as { code: string }).code, "ORG_ACCESS_REQUIRES_PAID");
});
