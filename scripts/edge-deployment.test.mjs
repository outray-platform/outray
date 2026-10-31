import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = readFileSync(new URL("../deploy.sh", import.meta.url), "utf8");
const selector = script.slice(script.indexOf("select_tunnel_slot() {"), script.indexOf("\nselect_tunnel_slot\n"));

function select(port, caddy = "") {
  const directory = mkdtempSync(join(tmpdir(), "outray-slot-test-"));
  const file = join(directory, "Caddyfile");
  writeFileSync(file, caddy);
  try {
    return spawnSync("bash", ["-c", `${selector}\nselect_tunnel_slot || exit 1\nprintf '%s %s %s %s' "$CURRENT_COLOR" "$TARGET_NAME" "$TARGET_PORT" "$OLD_NAME"`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CADDYFILE: file, OUTRAY_EDGE_CURRENT_PORT: port, BLUE_PORT: "3547", GREEN_PORT: "3548", BLUE_NAME: "outray-blue", GREEN_NAME: "outray-green" },
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("green traffic selects only the inactive blue slot regardless of leftover processes", () => {
  const result = select("3548");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "green outray-blue 3547 outray-green");
  assert.doesNotMatch(selector, /pm2/);
});

test("blue traffic selects only the inactive green slot", () => {
  const result = select("3547");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "blue outray-green 3548 outray-blue");
});

test("direct deployment reads the current Caddy upstream", () => {
  const result = select("", "example.test {\n reverse_proxy 127.0.0.1:3548 {\n }\n}\n");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "green outray-blue 3547 outray-green");
});

test("unknown or invalid upstreams fail closed", () => {
  for (const port of ["", "9999", "3548; echo invalid"]) {
    assert.equal(select(port).status, 1);
  }
});

test("inactive cleanup and health checks precede changing the live route", () => {
  assert.ok(script.indexOf('pm2 delete "$TARGET_NAME"') < script.indexOf("pm2 start dist/server.js"));
  assert.ok(script.indexOf("New tunnel edge failed its health check") < script.indexOf('mv "$CADDYFILE_CANDIDATE"'));
  assert.ok(script.indexOf('caddy reload --config $CADDYFILE') < script.indexOf('pm2 stop "$OLD_NAME"'));
});
