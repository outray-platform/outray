import assert from "node:assert/strict";
import test from "node:test";
import { recordUsageCounters, type CounterEvent } from "../src/usage-writer";
import { recordProductUsage } from "../src/tunnel-accounting";
const event: CounterEvent = { organizationId: "org", source: "tunnel-traffic", id: "stable-batch", timestamp: "2026-10-31T00:00:00Z", deltas: { "tunnels.http_requests": "9007199254740993" } };
test("preserves exact counts and SQL-function contract", async () => {
  let called = false;
  assert.equal(await recordUsageCounters({ async query(sql, args) {
    called = true; assert.ok(sql.startsWith("SELECT record_product_usage("));
    assert.equal(args?.[2], "stable-batch");
    assert.equal(args?.[4], '{"tunnels.http_requests":"9007199254740993"}');
    return { rows: [{ recorded: true }] };
  } }, event, new Set(["tunnels.http_requests"])), true);
  assert.equal(called, true);
});
test("edge rejects private-product counters before SQL", async () => {
  await assert.rejects(recordProductUsage({ async query() { throw new Error("Unexpected SQL"); } }, { ...event, deltas: { "secrets.added": 1 } } as any), /Invalid usage delta/);
});
test("rejects unsafe integers, negatives and overflow", async () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, "9223372036854775808"])
    await assert.rejects(recordUsageCounters({ async query() { throw new Error("Unexpected SQL"); } }, { ...event, deltas: { "tunnels.http_requests": value } }, new Set(["tunnels.http_requests"])));
});
