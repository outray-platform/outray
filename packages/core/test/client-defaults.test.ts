import assert from "node:assert/strict";
import test from "node:test";
import { OutrayClient } from "../src/client";

function serverUrl(client: OutrayClient): string {
  return (client as unknown as { options: { serverUrl: string } }).options
    .serverUrl;
}

test("core tunnel clients default to connect.outray.co without starting a connection", () => {
  assert.equal(
    serverUrl(new OutrayClient({ localPort: 3000 })),
    "wss://connect.outray.co/",
  );
});

test("explicit tunnel servers retain legacy aliases and self-hosted URLs", () => {
  for (const endpoint of [
    "wss://api.outray.dev/",
    "wss://tunnel.example.test/",
    "ws://localhost:3547",
  ]) {
    assert.equal(
      serverUrl(new OutrayClient({ localPort: 3000, serverUrl: endpoint })),
      endpoint,
    );
  }
});

test("guest expiry and policy errors stop SDK auto-reconnect", async () => {
  for (const code of ["AUTH_REQUIRED", "TUNNEL_EXPIRED", "RATE_LIMITED"]) {
    const errors: string[] = [];
    const client = new OutrayClient({ localPort: 3000, onError: (_error, code) => { errors.push(code!); } });
    const control = client as unknown as { handleMessage(message: string): void; shouldReconnect: boolean; reconnectTimeout: unknown };
    control.handleMessage(JSON.stringify({ type: "error", code, message: "Guest session ended" }));
    assert.equal(control.shouldReconnect, false);
    assert.equal(control.reconnectTimeout, null);
    assert.deepEqual(errors, [code]);
  }
});

test("a policy close without an error frame stops SDK guest reconnection", () => {
  const client = new OutrayClient({ localPort: 3000 });
  const control = client as unknown as { handleClose(code: number, reason: Buffer): void; shouldReconnect: boolean; reconnectTimeout: unknown };
  control.handleClose(1008, Buffer.from("Guest tunnel expired"));
  assert.equal(control.shouldReconnect, false);
  assert.equal(control.reconnectTimeout, null);
});
