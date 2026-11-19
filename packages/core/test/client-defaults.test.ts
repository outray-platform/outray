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

test("access options are sent in the open_tunnel handshake", () => {
  const sent: string[] = [];
  const client = new OutrayClient({ localPort: 3000, apiKey: "key", access: "organization", accessBypass: ["/webhooks"] });
  const control = client as unknown as { ws: { send(data: string): void }; handleOpen(): void; startPing(): void };
  control.startPing = () => {};
  control.ws = { send: data => { sent.push(data); } };
  control.handleOpen();
  const handshake = JSON.parse(sent[0]);
  assert.equal(handshake.access, "organization");
  assert.deepEqual(handshake.accessBypass, ["/webhooks"]);
});

test("organization access policy errors stop SDK auto-reconnect", () => {
  for (const code of ["ORG_ACCESS_REQUIRES_PAID", "ORG_ACCESS_UNAVAILABLE", "INVALID_ACCESS"]) {
    const client = new OutrayClient({ localPort: 3000, apiKey: "key" });
    const control = client as unknown as { handleMessage(message: string): void; shouldReconnect: boolean };
    control.handleMessage(JSON.stringify({ type: "error", code, message: "denied" }));
    assert.equal(control.shouldReconnect, false, code);
  }
});

test("SDK callers hear the effective access on open and on console changes", () => {
  const seen: string[] = [];
  const client = new OutrayClient({ localPort: 3000, apiKey: "key", onAccessChange: access => { seen.push(access); } });
  const control = client as unknown as { handleMessage(message: string): void };
  control.handleMessage(JSON.stringify({ type: "tunnel_opened", url: "https://app.example.test", access: "organization" }));
  control.handleMessage(JSON.stringify({ type: "access_updated", access: "public" }));
  assert.deepEqual(seen, ["organization", "public"]);
});

test("an organization tunnel refuses to run on an edge that ignores access", () => {
  const codes: string[] = [];
  let ready = false;
  const client = new OutrayClient({ localPort: 3000, apiKey: "key", access: "organization", onTunnelReady: () => { ready = true; }, onError: (_error, code) => { codes.push(code!); } });
  const control = client as unknown as { handleMessage(message: string): void; shouldReconnect: boolean };
  control.handleMessage(JSON.stringify({ type: "tunnel_opened", url: "https://app.example.test" }));
  assert.deepEqual(codes, ["ORG_ACCESS_UNSUPPORTED"]);
  assert.equal(ready, false);
  assert.equal(control.shouldReconnect, false);
});
