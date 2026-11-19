import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { TunnelRouter, type TunnelMetadata } from "../src/core/TunnelRouter";

const open = { readyState: WebSocket.OPEN, terminate() {}, send() {} } as unknown as WebSocket;

async function router(metadata: TunnelMetadata, available = true) {
  const instance = new TunnelRouter({ organizationAccessAvailable: () => available });
  assert.ok(await instance.registerTunnel("app.example.test", open, metadata));
  return instance;
}
const live = { organizationId: "org-a", dbTunnelId: "db-a", plan: "pro", access: "public" as const };
const change = { tunnelId: "app.example.test", organizationId: "org-a", dbTunnelId: "db-a" };

test("the console can switch a live tunnel between public and organization access", async () => {
  const r = await router(live);
  assert.equal(r.applyAccessChange({ ...change, access: "organization" }), true);
  assert.equal(r.getTunnelMetadata("app.example.test")?.access, "organization");
  assert.equal(r.applyAccessChange({ ...change, access: "public" }), true);
  assert.equal(r.getTunnelMetadata("app.example.test")?.access, "public");
});

test("console access changes require the owning tunnel and cannot override passwords or plan limits", async () => {
  for (const [metadata, message, available] of [
    [live, { ...change, organizationId: "org-b", access: "organization" }, true],
    [live, { ...change, dbTunnelId: "db-other", access: "organization" }, true],
    [live, { ...change, tunnelId: "missing.example.test", access: "organization" }, true],
    [live, { ...change, access: "password" }, true],
    [{ ...live, access: "password" as const, password: "x" }, { ...change, access: "public" }, true],
    [{ ...live, plan: "free" }, { ...change, access: "organization" }, true],
    [live, { ...change, access: "organization" }, false],
  ] as const) {
    const r = await router(metadata, available);
    assert.equal(r.applyAccessChange(message), false, JSON.stringify(message));
    assert.equal(r.getTunnelMetadata("app.example.test")?.access, metadata.access);
  }
});
