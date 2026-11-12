import { randomUUID } from "node:crypto";
import type Redis from "ioredis";

export class TunnelReservationBusyError extends Error {
  constructor() { super("Tunnel address is being updated. Please try again."); }
}

/** Shared Redis lock protocol used by the console and tunnel edge. Keep the
 * key and lease duration identical in both repositories. Never release a lease
 * that has expired and been acquired by another request. */
export async function withTunnelReservationLock<T>(
  redis: Redis | undefined,
  hostname: string,
  operation: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!redis) return operation(async () => {});
  const key = `tunnel:reservation_lock:${hostname}`;
  const token = randomUUID();
  const leaseMs = 30_000;
  if (await redis.set(key, token, "PX", leaseMs, "NX") !== "OK") {
    throw new TunnelReservationBusyError();
  }
  const renew = setInterval(() => {
    void redis.eval(`
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('PEXPIRE', KEYS[1], ARGV[2])
      end
      return 0
    `, 1, key, token, leaseMs).catch(() => {});
  }, leaseMs / 3);
  renew.unref();
  const assertHeld = async () => {
    if (await redis.get(key) !== token) throw new TunnelReservationBusyError();
  };
  try {
    const result = await operation(assertHeld);
    await assertHeld();
    return result;
  } finally {
    clearInterval(renew);
    await redis.eval(`
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `, 1, key, token);
  }
}

export default { withTunnelReservationLock, TunnelReservationBusyError };
