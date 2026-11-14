import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type Redis from "ioredis";

export const GUEST_LIFETIME_MS = 60 * 60 * 1000;
export const GUEST_STARTS_PER_MINUTE = 5;

function normalizeIp(value: string): string | undefined {
  if (value.startsWith("::ffff:") && isIP(value.slice(7)) === 4) return value.slice(7);
  if (isIP(value) === 4) return value;
  if (isIP(value) === 6) {
    try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return; }
  }
}

/** Only explicitly trusted reverse proxies may supply forwarding headers.
 * Use the rightmost address: an untrusted client cannot add a new last hop. */
export function guestClientIp(request: IncomingMessage, trustedPeers: readonly string[]): string | undefined {
  const peer = normalizeIp(request.socket.remoteAddress || "");
  if (!peer) return;
  if (trustedPeers.some(value => normalizeIp(value) === peer)) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const address = normalizeIp(forwarded.split(",").at(-1)!.trim());
      if (address) return address;
    }
  }
  return peer;
}

export interface GuestLease {
  guestLeaseKey: string;
  guestSessionId: string;
  expiresAt: number;
}

/** Redis owns the clock and admission decision across all edge processes.
 * A short active lease is refreshed by the router, bounded by expiresAt, so an
 * edge crash releases capacity without waiting for the full guest lifetime. */
export class GuestTunnelLimits {
  constructor(
    private redis: Redis | undefined,
    private activeLeaseMs = 120_000,
    private lifetimeMs = GUEST_LIFETIME_MS,
  ) {}

  async admit(ip: string): Promise<GuestLease | undefined> {
    if (!this.redis) throw new Error("Guest tunnel limits unavailable");
    const id = createHash("sha256").update(ip).digest("hex");
    const guestLeaseKey = `tunnel:guest:active:${id}`;
    const guestSessionId = randomUUID();
    const expiresAt = Number(await this.redis.eval(`
      local clock = redis.call('TIME')
      local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
      redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 60000)
      if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) or redis.call('EXISTS', KEYS[1]) == 1 then
        return 0
      end
      local expires = now + tonumber(ARGV[3])
      redis.call('SET', KEYS[1], ARGV[1], 'PX', math.min(tonumber(ARGV[4]), tonumber(ARGV[3])))
      redis.call('ZADD', KEYS[2], now, ARGV[1])
      redis.call('PEXPIRE', KEYS[2], 60000)
      return expires
    `, 2, guestLeaseKey, `tunnel:guest:starts:${id}`, guestSessionId,
    GUEST_STARTS_PER_MINUTE, this.lifetimeMs, this.activeLeaseMs));
    if (!expiresAt) return;
    return { guestLeaseKey, guestSessionId, expiresAt };
  }

  async release(lease: GuestLease): Promise<void> {
    if (!this.redis) return;
    await this.redis.eval(`
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `, 1, lease.guestLeaseKey, lease.guestSessionId);
  }
}
