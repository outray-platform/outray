import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NEXT_DEV_ORIGINS_DOCS_URL,
  formatAllowedDevOriginsHint,
  isDevOriginAllowed,
  tunnelHostname,
} from "../src/dev-origins";

test("extracts the bare tunnel hostname", () => {
  assert.equal(tunnelHostname("https://my-app.outray.app/"), "my-app.outray.app");
  assert.equal(tunnelHostname("not a url"), null);
});

test("treats exact and matching wildcard entries as already allowed", () => {
  const host = "my-app.outray.app";
  assert.equal(isDevOriginAllowed(["my-app.outray.app"], host), true);
  assert.equal(isDevOriginAllowed(["MY-APP.outray.app"], host), true);
  assert.equal(isDevOriginAllowed(["*.outray.app"], host), true);
  assert.equal(isDevOriginAllowed(["**.outray.app"], host), true);
});

test("still suggests the host when the config does not cover it", () => {
  const host = "my-app.outray.app";
  assert.equal(isDevOriginAllowed(undefined, host), false);
  assert.equal(isDevOriginAllowed([], host), false);
  assert.equal(isDevOriginAllowed(["other.outray.app", "localhost"], host), false);
  assert.equal(isDevOriginAllowed(["*.example.com", "*", "**"], host), false);
  assert.equal(isDevOriginAllowed(["*.my-app.outray.app"], host), false);
});

test("formats a hint with the exact hostname, never a wildcard", () => {
  const hint = formatAllowedDevOriginsHint("my-app.outray.app").join("\n");
  assert.match(hint, /allowedDevOrigins: \["my-app\.outray\.app"\],/);
  assert.match(hint, /restart next dev/);
  assert.ok(hint.includes(NEXT_DEV_ORIGINS_DOCS_URL));
  assert.doesNotMatch(hint, /\*/);
});
