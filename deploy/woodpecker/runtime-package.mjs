import { readFileSync } from "node:fs";
const source = JSON.parse(readFileSync(process.argv[2], "utf8"));
const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
for (const version of Object.values(source.dependencies || {})) {
  if (typeof version !== "string" || /^(?:file:|link:|workspace:|\.\.?\/)/.test(version)) throw new Error("Publish dependencies before deploying the edge.");
}
process.stdout.write(JSON.stringify({ name: source.name, version: source.version, private: true, engines: { node: ">=22.19.0" }, dependencies: source.dependencies, overrides: root.overrides }, null, 2) + "\n");
