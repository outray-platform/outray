import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { HTTPProxy } from "../../src/core/HTTPProxy";

/** Run the production HTTP proxy without analytics queues or Redis-backed loggers. */
export async function loadHTTPProxy() {
  const path = new URL("../../src/core/HTTPProxy.ts", import.meta.url);
  const compiled = ts.transpileModule(await readFile(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as { HTTPProxy: typeof HTTPProxy; passwordsMatch(a: string, b: string): boolean } };
  const require = createRequire(path);
  const noop = { log() {} };
  runInNewContext(compiled, {
    module, exports: module.exports, __dirname: new URL("../../src/core/", import.meta.url).pathname,
    require: (specifier: string) => specifier === "../lib/tinybird" ? { logger: noop, requestCaptureLogger: noop } : require(specifier),
    process, console: { log() {}, error() {} }, Buffer, URL, URLSearchParams, setTimeout, clearTimeout,
  });
  return module.exports;
}
