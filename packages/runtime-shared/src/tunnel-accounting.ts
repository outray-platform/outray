import { recordUsageCounters, type CounterEvent, type UsageDatabase } from "./usage-writer";
export const tunnelUsageMetrics = [
  "tunnels.opens.http", "tunnels.opens.tcp", "tunnels.opens.udp",
  "tunnels.registrations.http", "tunnels.registrations.tcp", "tunnels.registrations.udp",
  "tunnels.http_requests", "tunnels.tcp_connections", "tunnels.udp_datagrams.in", "tunnels.udp_datagrams.out",
  "tunnels.bytes.http.in", "tunnels.bytes.http.out", "tunnels.bytes.tcp.in", "tunnels.bytes.tcp.out",
  "tunnels.bytes.udp.in", "tunnels.bytes.udp.out",
] as const;
export type UsageMetric = typeof tunnelUsageMetrics[number];
export type UsageEvent = CounterEvent<UsageMetric>;
export type { UsageDatabase };
const known = new Set<string>(tunnelUsageMetrics);
export const recordProductUsage = (database: UsageDatabase, event: UsageEvent) => recordUsageCounters(database, event, known);
export default { recordProductUsage };
