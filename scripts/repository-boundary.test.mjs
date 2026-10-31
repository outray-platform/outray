import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
test("public builds contain tools only and require no private icon license", () => {
  const apps = readdirSync(join(root, "apps")).filter(name => existsSync(join(root, "apps", name, "package.json")));
  assert.deepEqual(apps.sort(), ["cli", "tunnel"]);
  for (const path of ["apps/web", "apps/status", "packages/icons"]) assert.ok(!existsSync(join(root, path, "package.json")));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
  assert.ok(!Object.keys(lock.packages).some(path => /hugeicons-pro|^apps\/(web|status|cron|ingest|delivery|uptime-probe)(\/|$)/.test(path)));
  assert.match(readFileSync(join(root, "LICENSE"), "utf8"), /MIT License/);
});
test("edge promotion cannot start private services or cron", () => {
  const deploy = readFileSync(join(root, "deploy.sh"), "utf8");
  assert.doesNotMatch(deploy, /pm2 (?:start|restart).*outray-cron|cd \.\.\/internal-check|PAYSTACK_SECRET_KEY|OUTRAY_SECRETS_ACTIVE_MASTER_KEY/);
  const release = readFileSync(join(root, "deploy/woodpecker/deploy-edge.sh"), "utf8");
  assert.match(release, /outray-deployment\.lock/);
  assert.match(release, /outray-edge\/releases/);
  assert.doesNotMatch(release, /OPS_SECRETS_TOKEN|apps\/internal-check|apps\/cron/);
});
