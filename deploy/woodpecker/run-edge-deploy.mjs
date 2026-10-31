import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error("The edge requires Node >=22.19.");
const root = fileURLToPath(new URL("../../", import.meta.url));
const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8" }));
const port = readFileSync("/etc/caddy/Caddyfile", "utf8").match(/reverse_proxy\s+127\.0\.0\.1:(3547|3548)\b/)?.[1];
const active = processes.filter(item => ["outray-blue", "outray-green"].includes(item.name) && item.pm2_env?.status === "online");
const current = active.find(item => String(item.pm2_env.PORT) === port) || (active.length === 1 ? active[0] : undefined);
if (!current) throw new Error("Cannot identify the active edge; existing processes were not modified.");
// Only edge settings: no email, billing, vault master keys or platform deployment token.
const names = ["BASE_DOMAIN", "REDIS_URL", "REDIS_TUNNEL_TTL_SECONDS", "REDIS_HEARTBEAT_INTERVAL_MS", "DATABASE_URL", "DATABASE_SSL_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "INTERNAL_API_SECRET", "TINYBIRD_API_HOST", "TINYBIRD_INGEST_TOKEN", "TINYBIRD_TUNNEL_INGEST_TOKEN", "OUTRAY_API_KEY", "OUTRAY_OTLP_ENDPOINT", "UPTIME_ENABLED", "OUTRAY_STATUS_URL", "OUTRAY_DASHBOARD_URL", "STATUS_EDGE_SECRET", "STATUS_UPSTREAM_URL", "STATUS_TRUSTED_PROXY_IPS", "TCP_PORT_RANGE_MIN", "TCP_PORT_RANGE_MAX", "UDP_PORT_RANGE_MIN", "UDP_PORT_RANGE_MAX", "REQUEST_TIMEOUT_MS"];
const runtime = Object.fromEntries(names.filter(name => typeof current.pm2_env[name] === "string").map(name => [name, current.pm2_env[name]]));
runtime.OUTRAY_DASHBOARD_URL = "https://outray.co";
runtime.WEB_API_URL = "https://outray.co/api";
runtime.OUTRAY_EDGE_CURRENT_PORT = port || String(current.pm2_env.PORT);
runtime.OUTRAY_STATUS_URL ||= "https://status.outray.app";
const ca = "/etc/ssl/outray/brimble-ca.pem";
if (!runtime.NODE_EXTRA_CA_CERTS && existsSync(ca)) {
  const stat = statSync(ca);
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022) throw new Error("Unsafe host database CA.");
  runtime.NODE_EXTRA_CA_CERTS = ca;
}
for (const name of ["DATABASE_URL", "REDIS_URL", "TINYBIRD_API_HOST", "TINYBIRD_INGEST_TOKEN", "INTERNAL_API_SECRET"]) if (!runtime[name]) throw new Error(`Missing edge runtime setting: ${name}`);
// Artifacts are promoted only while deploy-edge.sh holds the shared host lock.
cpSync(new URL("tunnel/", new URL(`file://${root}`)), "/root/outray/tunnel", { recursive: true });
const result = spawnSync("/bin/bash", [root + "deploy.sh"], { cwd: root, env: { ...process.env, ...runtime }, stdio: "inherit" });
process.exit(result.status ?? 1);
