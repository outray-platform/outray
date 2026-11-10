const test = require("node:test");
const assert = require("node:assert/strict");
const { isNextDevServer } = require("../dist/next-dev-origins.js");

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
