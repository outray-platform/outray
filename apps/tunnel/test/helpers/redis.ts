import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import Redis from "ioredis";

/** Isolated Redis process: no production configuration or shared keys. */
export async function isolatedRedis(t: TestContext, beforeClose?: () => Promise<void>): Promise<Redis | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "outray-redis-"));
  const socket = join(directory, "redis.sock");
  const child = spawn("redis-server", ["--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  let failure: NodeJS.ErrnoException | undefined;
  child.on("error", error => { failure = error; });
  let redis: Redis | undefined;
  t.after(async () => {
    await beforeClose?.();
    redis?.disconnect();
    if (child.exitCode === null && child.pid) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure?.code === "ENOENT") { t.skip("redis-server is required for Redis integration tests"); return; }
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`Test Redis exited with ${child.exitCode}`);
    if (await stat(socket).then(() => true, () => false)) {
      redis = new Redis({ path: socket, lazyConnect: true, retryStrategy: () => null });
      redis.on("error", () => {});
      await redis.connect();
      return redis;
    }
    await delay(10);
  }
  throw new Error("Test Redis did not start");
}
