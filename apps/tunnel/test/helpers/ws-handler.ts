import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { WSHandler } from "../../src/core/WSHandler";

/** Run the production handler with isolated control-plane and accounting I/O. */
export async function loadWSHandler(fetch: typeof globalThis.fetch, recordTunnelOpening: (...args: unknown[]) => Promise<void>) {
  const path = new URL("../../src/core/WSHandler.ts", import.meta.url);
  const compiled = ts.transpileModule(await readFile(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as { WSHandler: typeof WSHandler } };
  const require = createRequire(path);
  runInNewContext(compiled, {
    module, exports: module.exports,
    require: (specifier: string) => specifier === "../lib/product-usage" ? { recordTunnelOpening } : require(specifier),
    process: { env: { WEB_API_URL: "https://control.example.test/api" } },
    fetch, console: { log() {}, error() {} }, Buffer, setInterval, clearInterval,
  });
  return module.exports.WSHandler;
}
