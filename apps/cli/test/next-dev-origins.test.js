const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NEXT_DEV_ORIGINS_DOCS_URL,
  formatAllowedDevOriginsHint,
  isNextDevServer,
} = require("../dist/next-dev-origins.js");

test("detects Next.js from dev asset and HMR paths", () => {
  for (const path of [
    "/_next/static/css/app.css",
    "/_next/webpack-hmr",
    "/__nextjs_original-stack-frame?file=x",
  ]) {
    assert.equal(isNextDevServer(path), true, path);
  }
});

test("detects Next.js from the x-powered-by response header", () => {
  assert.equal(isNextDevServer("/", { "x-powered-by": "Next.js" }), true);
  assert.equal(isNextDevServer("/", { "x-powered-by": ["Express", "Next.js"] }), true);
});

test("ignores other servers and look-alike paths", () => {
  assert.equal(isNextDevServer("/", {}), false);
  assert.equal(isNextDevServer("/", { "x-powered-by": "Express" }), false);
  assert.equal(isNextDevServer("/api/_next/data", {}), false);
  assert.equal(isNextDevServer("/_nextjs", {}), false);
  assert.equal(isNextDevServer(undefined, {}), false);
});

test("formats the allowedDevOrigins hint with the exact tunnel hostname", () => {
  const hint = formatAllowedDevOriginsHint("https://my-app.outray.app/some/path");
  assert.match(hint, /allowedDevOrigins: \["my-app\.outray\.app"\],/);
  assert.match(hint, /restart next dev/);
  assert.ok(hint.includes(NEXT_DEV_ORIGINS_DOCS_URL));
  assert.doesNotMatch(hint, /\*\./);
  assert.match(
    formatAllowedDevOriginsHint("https://preview.example.com"),
    /\["preview\.example\.com"\]/,
  );
  assert.equal(formatAllowedDevOriginsHint("not a url"), null);
});
