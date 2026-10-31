export interface UsageDatabase { query(text: string, values?: any[]): Promise<any> }
export interface CounterEvent<Metric extends string = string> {
  organizationId: string; source: string; id: string; timestamp: string;
  deltas: Partial<Record<Metric, string | number>>;
}
/** Transport and validation only; callers supply their product's metric catalog. */
export async function recordUsageCounters<Metric extends string>(database: UsageDatabase, event: CounterEvent<Metric>, allowedMetrics: ReadonlySet<string>): Promise<boolean> {
  if (!event.organizationId || event.organizationId.length > 128 || !/^[a-z][a-z0-9-]{0,63}$/.test(event.source) || !event.id || event.id.length > 256 || !Number.isFinite(Date.parse(event.timestamp))) throw new Error("Invalid usage event");
  const deltas: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.deltas).sort(([a], [b]) => a.localeCompare(b))) {
    if (!allowedMetrics.has(key) || (typeof value === "number" && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) throw new Error("Invalid usage delta");
    const count = BigInt(value as string | number);
    if (count > 9223372036854775807n) throw new Error("Usage delta overflow");
    if (count > 0n) deltas[key] = String(count);
  }
  if (!Object.keys(deltas).length) return false;
  const result = await database.query("SELECT record_product_usage($1,$2,$3,$4::timestamptz,$5::jsonb) AS recorded", [event.organizationId, event.source, event.id, event.timestamp, JSON.stringify(deltas)]);
  return result.rows[0]?.recorded === true;
}
