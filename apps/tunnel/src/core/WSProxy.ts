import { IncomingMessage } from "http";
import { Duplex } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import { TunnelRouter } from "./TunnelRouter";
import { Protocol, WSUpgradeResponseMessage, WSFrameMessage, WSCloseMessage } from "./Protocol";
import { generateId } from "../../../../shared/utils";
import type { AccessIdentity, TunnelAccessGate } from "../lib/tunnel-access-gate";
import { matchesBypass } from "../lib/tunnel-access-policy";

const STATUS_TEXT: Record<number, string> = { 401: "Unauthorized", 403: "Forbidden", 503: "Service Unavailable" };

interface PendingUpgrade {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  tunnelId: string;
  controlWs: WebSocket;
  timeout: NodeJS.Timeout;
}

/**
 * Handles end-user WebSocket connections through HTTP tunnels.
 *
 * When an end-user connects via WebSocket to a tunneled subdomain
 * (e.g., ws://myapp.outray.app/socket), this proxy:
 *
 * 1. Sends a ws_upgrade message to the tunnel client via the control WebSocket
 * 2. Waits for the client to open a local WebSocket and confirm with ws_upgrade_response
 * 3. Completes the HTTP upgrade for the end-user
 * 4. Relays frames bidirectionally: end-user ↔ control WS ↔ local WS
 */
export class WSProxy {
  private router: TunnelRouter;
  private wss: WebSocketServer;
  private pendingUpgrades = new Map<string, PendingUpgrade>();
  private activeConnections = new Map<string, WebSocket>();
  private connectionOwners = new Map<string, { tunnelId: string; controlWs: WebSocket; path: string; identity?: AccessIdentity }>();
  private pendingIdentities = new Map<string, AccessIdentity>();
  private readonly UPGRADE_TIMEOUT_MS = 10000;
  private accessGate?: TunnelAccessGate;
  private recheckTimer?: NodeJS.Timeout;

  constructor(router: TunnelRouter, accessGate?: TunnelAccessGate, accessRecheckMs = 60_000) {
    this.router = router;
    this.wss = new WebSocketServer({ noServer: true });
    this.accessGate = accessGate;
    this.recheckTimer = setInterval(() => void this.recheckAccess(), accessRecheckMs);
    this.recheckTimer.unref();
  }

  shutdown(): void {
    clearInterval(this.recheckTimer);
  }

  /**
   * Long-lived sockets outlive the request that authorized them. Close any whose
   * grant was revoked, and any opened without sign-in once the tunnel requires it.
   */
  async recheckAccess(tunnelId?: string): Promise<void> {
    await Promise.all(Array.from(this.connectionOwners, async ([id, owner]) => {
      if (tunnelId !== undefined && owner.tunnelId !== tunnelId) return;
      const metadata = this.router.getTunnelMetadata(owner.tunnelId);
      if (metadata?.access !== "organization") return;
      if (owner.identity && this.accessGate && await this.accessGate.stillAuthorized(owner.identity)) return;
      if (!owner.identity && matchesBypass(owner.path, metadata.accessBypass)) return;
      this.activeConnections.get(id)?.close(1008, "Organization access required");
    }));
  }

  private reject(socket: Duplex, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
    const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}`, "Connection: close"];
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === "location") continue;
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
    socket.destroy();
  }

  /**
   * Handle an HTTP upgrade request for a tunneled subdomain.
   * Sends a ws_upgrade to the tunnel client and waits for confirmation
   * before completing the upgrade with the end-user.
   */
  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const host = (request.headers.host || "").split(":")[0].toLowerCase();
    const tunnelId = host;

    let identity: AccessIdentity | undefined;
    const metadata = this.router.getTunnelMetadata(tunnelId);
    if (metadata?.access === "organization") {
      if (!this.accessGate) {
        this.reject(socket, 503, "Organization access is unavailable");
        return;
      }
      const decision = await this.accessGate.authorizeUpgrade(request, host, metadata);
      if (decision.action === "respond") {
        this.reject(socket, decision.status, decision.body, decision.headers);
        return;
      }
      if (socket.destroyed) return;
      identity = decision.identity;
    }

    // Verify the tunnel exists
    const tunnelWs = this.router.getTunnel(tunnelId);
    if (!tunnelWs || tunnelWs.readyState !== WebSocket.OPEN) {
      socket.write(
        "HTTP/1.1 502 Bad Gateway\r\n" +
        "Content-Type: text/plain\r\n" +
        "Connection: close\r\n\r\n" +
        "Tunnel is offline"
      );
      socket.destroy();
      return;
    }

    const wsConnectionId = generateId("wsc");

    // Store the pending upgrade
    const timeout = setTimeout(() => {
      this.pendingUpgrades.delete(wsConnectionId);
      this.pendingIdentities.delete(wsConnectionId);
      socket.write(
        "HTTP/1.1 504 Gateway Timeout\r\n" +
        "Content-Type: text/plain\r\n" +
        "Connection: close\r\n\r\n" +
        "WebSocket upgrade timed out"
      );
      socket.destroy();
      console.log(`WebSocket upgrade timed out for connection ${wsConnectionId}`);
    }, this.UPGRADE_TIMEOUT_MS);

    this.pendingUpgrades.set(wsConnectionId, {
      request,
      socket,
      head,
      tunnelId,
      controlWs: tunnelWs,
      timeout,
    });

    // Build headers to forward (filter out hop-by-hop headers)
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) {
        headers[key] = value;
      }
    }
    if (metadata?.access === "organization") this.accessGate?.stripCookie(headers);
    if (identity) this.pendingIdentities.set(wsConnectionId, identity);

    // Send ws_upgrade to the tunnel client
    tunnelWs.send(
      Protocol.encode({
        type: "ws_upgrade",
        wsConnectionId,
        path: request.url || "/",
        headers,
        protocol: request.headers["sec-websocket-protocol"],
      })
    );

    console.log(`→ WebSocket upgrade requested: ${tunnelId}${request.url} (${wsConnectionId})`);
  }

  /**
   * Called when the tunnel client responds to a ws_upgrade request.
   */
  handleUpgradeResponse(message: WSUpgradeResponseMessage, controlWs: WebSocket): void {
    const pending = this.pendingUpgrades.get(message.wsConnectionId);
    if (!pending || pending.controlWs !== controlWs) {
      console.warn(`No pending upgrade for wsConnectionId: ${message.wsConnectionId}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingUpgrades.delete(message.wsConnectionId);
    const identity = this.pendingIdentities.get(message.wsConnectionId);
    this.pendingIdentities.delete(message.wsConnectionId);

    if (this.router.getTunnel(pending.tunnelId) !== pending.controlWs) {
      pending.socket.destroy();
      return;
    }

    if (!message.success) {
      pending.socket.write(
        "HTTP/1.1 502 Bad Gateway\r\n" +
        "Content-Type: text/plain\r\n" +
        "Connection: close\r\n\r\n" +
        (message.error || "Failed to connect to local WebSocket server")
      );
      pending.socket.destroy();
      console.log(`✗ WebSocket upgrade failed: ${message.wsConnectionId} - ${message.error}`);
      return;
    }

    // Complete the upgrade for the end-user
    this.wss.handleUpgrade(pending.request, pending.socket, pending.head, (endUserWs) => {
      this.activeConnections.set(message.wsConnectionId, endUserWs);
      this.connectionOwners.set(message.wsConnectionId, { tunnelId: pending.tunnelId, controlWs: pending.controlWs, path: pending.request.url || "/", identity });

      console.log(`✓ WebSocket connection established: ${message.wsConnectionId}`);

      // Forward frames from end-user to tunnel client
      endUserWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        const tunnelWs = this.router.getTunnel(pending.tunnelId);
        if (tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          tunnelWs.send(
            Protocol.encode({
              type: "ws_frame",
              wsConnectionId: message.wsConnectionId,
              data: buffer.toString("base64"),
              isBinary,
            })
          );
        }
      });

      // Handle end-user disconnect
      endUserWs.on("close", (code, reason) => {
        this.activeConnections.delete(message.wsConnectionId);
        this.connectionOwners.delete(message.wsConnectionId);
        const tunnelWs = this.router.getTunnel(pending.tunnelId);
        if (tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
          tunnelWs.send(
            Protocol.encode({
              type: "ws_close",
              wsConnectionId: message.wsConnectionId,
              code,
              reason: reason?.toString(),
            })
          );
        }
        console.log(`WebSocket closed by end-user: ${message.wsConnectionId} (code: ${code})`);
      });

      endUserWs.on("error", (error) => {
        console.error(`WebSocket error for ${message.wsConnectionId}:`, error);
        this.activeConnections.delete(message.wsConnectionId);
        this.connectionOwners.delete(message.wsConnectionId);
      });
    });
  }

  /**
   * Called when the tunnel client sends a WebSocket frame from the local server.
   */
  handleFrame(message: WSFrameMessage, controlWs: WebSocket): void {
    if (this.connectionOwners.get(message.wsConnectionId)?.controlWs !== controlWs) return;
    const endUserWs = this.activeConnections.get(message.wsConnectionId);
    if (!endUserWs || endUserWs.readyState !== WebSocket.OPEN) {
      return;
    }

    const data = Buffer.from(message.data, "base64");
    endUserWs.send(data, { binary: message.isBinary });
  }

  /**
   * Called when the tunnel client signals that the local WebSocket closed.
   */
  handleClose(message: WSCloseMessage, controlWs: WebSocket): void {
    if (this.connectionOwners.get(message.wsConnectionId)?.controlWs !== controlWs) return;
    const endUserWs = this.activeConnections.get(message.wsConnectionId);
    if (!endUserWs) {
      return;
    }

    this.activeConnections.delete(message.wsConnectionId);
    this.connectionOwners.delete(message.wsConnectionId);
    endUserWs.close(message.code || 1000, message.reason || "");
    console.log(`WebSocket closed by local server: ${message.wsConnectionId} (code: ${message.code})`);
  }

  /**
   * Clean up all connections for a given tunnel (e.g., when the tunnel client disconnects).
   */
  cleanupTunnel(tunnelId: string, controlWs?: WebSocket): void {
    // Close pending upgrades for this tunnel
    for (const [id, pending] of this.pendingUpgrades) {
      if (pending.tunnelId === tunnelId && (!controlWs || pending.controlWs === controlWs)) {
        clearTimeout(pending.timeout);
        pending.socket.destroy();
        this.pendingUpgrades.delete(id);
        this.pendingIdentities.delete(id);
      }
    }

    for (const [id, owner] of this.connectionOwners) {
      if (owner.tunnelId === tunnelId && (!controlWs || owner.controlWs === controlWs)) {
        this.activeConnections.get(id)?.terminate();
        this.activeConnections.delete(id);
        this.connectionOwners.delete(id);
      }
    }
  }
}
