import WebSocket, { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { TunnelRouter, type TunnelMetadata } from "./TunnelRouter";
import { TCPProxy } from "./TCPProxy";
import { UDPProxy } from "./UDPProxy";
import {
  Protocol,
  Message,
  TCPDataMessage,
  TCPCloseMessage,
  UDPResponseMessage,
  WSUpgradeResponseMessage,
  WSFrameMessage,
  WSCloseMessage,
} from "./Protocol";
import { WSProxy } from "./WSProxy";

import { generateSubdomain } from "../../../../shared/utils";
import { config } from "../config";
import { randomUUID } from "node:crypto";
import { GuestTunnelLimits, guestClientIp, type GuestLease } from "../lib/guest-tunnels";
import { recordTunnelOpening } from "../lib/product-usage";
import { withTunnelReservationLock, TunnelReservationBusyError } from "../../../../shared/tunnel-reservation-lock";

export class WSHandler {
  private wss: WebSocketServer;
  private router: TunnelRouter;
  private tcpProxy: TCPProxy;
  private udpProxy: UDPProxy;
  private wsProxy: WSProxy | null;
  private webApiUrl: string;
  private guestLimits: GuestTunnelLimits;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

  constructor(
    wss: WebSocketServer,
    router: TunnelRouter,
    tcpProxy?: TCPProxy,
    udpProxy?: UDPProxy,
    wsProxy?: WSProxy,
  ) {
    this.router = router;
    this.guestLimits = new GuestTunnelLimits(router.getRedis(), Math.max(30, config.redisTunnelTtlSeconds) * 1000);
    this.wss = wss;
    this.tcpProxy = tcpProxy || new TCPProxy();
    this.udpProxy = udpProxy || new UDPProxy();
    this.wsProxy = wsProxy || null;
    this.webApiUrl = process.env.WEB_API_URL || "http://localhost:3000/api";
    this.setupWebSocketServer();
    this.startHeartbeatCheck();
  }

  /**
   * Server-side heartbeat check to detect and clean up dead connections.
   * This handles cases where clients go to sleep (laptop lid close) and
   * connections become "half-open" zombies that block reconnection.
   */
  private startHeartbeatCheck(): void {
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws: WebSocket) => {
        const extWs = ws as WebSocket & {
          isAlive?: boolean;
          tunnelId?: string;
        };

        if (extWs.isAlive === false) {
          // Client didn't respond to previous ping, terminate connection
          console.log(
            `Terminating unresponsive connection${extWs.tunnelId ? ` for tunnel ${extWs.tunnelId}` : ""}`,
          );
          return ws.terminate();
        }

        // Mark as not alive until we get a pong
        extWs.isAlive = false;
        ws.ping();
      });
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  public shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private async validateAuthToken(token: string): Promise<{
    valid: boolean;
    userId?: string;
    organizationId?: string;
    organization?: any;
    error?: string;
    tokenType?: "legacy" | "machine" | "org";
    bandwidthLimit?: number;
    retentionDays?: number;
    plan?: string;
    fullCaptureEnabled?: boolean;
  }> {
    try {
      const response = await fetch(`${this.webApiUrl}/tunnel/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) return { valid: false, error: "Authentication failed" };
      return (await response.json()) as {
        valid: boolean;
        userId?: string;
        organizationId?: string;
        organization?: any;
        error?: string;
        tokenType?: "legacy" | "machine" | "org";
        bandwidthLimit?: number;
        retentionDays?: number;
        plan?: string;
        fullCaptureEnabled?: boolean;
      };
    } catch (error) {
      console.error("Failed to validate Auth Token:", error);
      return { valid: false, error: "Internal server error" };
    }
  }

  private async checkSubdomain(
    subdomain: string,
    organizationId?: string,
  ): Promise<{
    allowed: boolean;
    type?: "owned" | "available";
    error?: string;
    code?: string;
  }> {
    try {
      const response = await fetch(`${this.webApiUrl}/tunnel/check-subdomain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain, organizationId }),
      });
      if (!response.ok) return { allowed: false, error: "Subdomain check failed" };
      return (await response.json()) as {
        allowed: boolean;
        type?: "owned" | "available";
        error?: string;
      };
    } catch (error) {
      console.error("Failed to check subdomain:", error);
      return { allowed: false, error: "Internal server error" };
    }
  }

  private async reserveSubdomain(
    subdomain: string,
    ws: WebSocket,
    metadata: TunnelMetadata,
    forceTakeover = false,
  ): Promise<{ reserved: boolean; code?: string; error?: string }> {
    const hostname = `${subdomain}.${config.baseDomain}`;
    try {
      return await withTunnelReservationLock(this.router.getRedis(), hostname, async (assertHeld) => {
        const check = await this.checkSubdomain(subdomain, metadata.organizationId);
        if (check.allowed !== true) return { reserved: false, code: check.code || "SUBDOMAIN_DENIED", error: check.error };
        if (ws.readyState !== WebSocket.OPEN) return { reserved: false };
        await assertHeld();
        const reserved = await this.router.reserveTunnel(hostname, ws, metadata, forceTakeover);
        return { reserved, code: "SUBDOMAIN_IN_USE", error: `Subdomain ${subdomain} is currently in use.` };
      });
    } catch (error) {
      if (error instanceof TunnelReservationBusyError) {
        return { reserved: false, code: "SUBDOMAIN_IN_USE", error: error.message };
      }
      throw error;
    }
  }

  private async registerTunnelInDatabase(
    userId: string | undefined,
    organizationId: string,
    url: string,
    options?: {
      protocol?: "http" | "tcp" | "udp";
      remotePort?: number;
      tunnelId?: string;
      name?: string;
    },
  ): Promise<{ success: boolean; tunnelId?: string; error?: string }> {
    try {
      const response = await fetch(`${this.webApiUrl}/tunnel/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          organizationId,
          url,
          protocol: options?.protocol || "http",
          remotePort: options?.remotePort,
          tunnelId: options?.tunnelId,
          name: options?.name,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as {
        success: boolean;
        tunnelId?: string;
      };
      return {
        success: data.success === true && typeof data.tunnelId === "string" && data.tunnelId.length > 0,
        tunnelId: data.tunnelId,
      };
    } catch (error) {
      console.error("Failed to register tunnel in database:", error);
      return { success: false, error: "Failed to connect to API" };
    }
  }

  private async verifyCustomDomain(
    domain: string,
    organizationId: string,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch(
        `${this.webApiUrl}/domain/verify-ownership`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain,
            organizationId,
          }),
        },
      );
      const data = (await response.json()) as {
        valid: boolean;
        error?: string;
      };
      return data;
    } catch (error) {
      console.error("Failed to verify custom domain:", error);
      return { valid: false, error: "Failed to verify custom domain" };
    }
  }

  private setupWebSocketServer(): void {
    this.wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      // Extend WebSocket with heartbeat tracking
      const extWs = ws as WebSocket & { isAlive: boolean; tunnelId?: string };
      extWs.isAlive = true;

      // Handle pong responses from clients
      ws.on("pong", () => {
        extWs.isAlive = true;
      });

      let tunnelId: string | null = null;
      let activeProtocol: "http" | "tcp" | "udp" | undefined;
      let opening = false;
      let closed = false;
      let guestLease: GuestLease | undefined;
      const allocated = new Set<string>();
      const cleanup = async () => {
        if (opening) return;
        for (const id of allocated) {
          allocated.delete(id);
          try {
            if (this.tcpProxy.hasTunnel(id)) await this.tcpProxy.closeTunnel(id);
            if (this.udpProxy.hasTunnel(id)) await this.udpProxy.closeTunnel(id);
            this.wsProxy?.cleanupTunnel(id, ws);
          } finally {
            await this.router.unregisterTunnel(id, ws);
          }
        }
        if (guestLease) await this.guestLimits.release(guestLease);
      };
      const usageSessionId = randomUUID();
      let usageOpenedAt: string | undefined;
      let usageRecorded = false;
      const countOpening = async (organizationId: string | undefined, protocol: "http" | "tcp" | "udp") => {
        if (!organizationId || usageRecorded) return;
        usageOpenedAt ??= new Date().toISOString();
        await recordTunnelOpening(organizationId, protocol, usageSessionId, usageOpenedAt);
        usageRecorded = true;
      };

      ws.on("message", async (data: WebSocket.Data) => {
        let ownsOpening = false;
        try {
          const message = Protocol.decode(data.toString()) as Message;
          if (guestLease && Date.now() >= guestLease.expiresAt) {
            ws.close(1008, "Guest tunnel expired");
            return;
          }

          if (message.type === "hello") {
            console.log(`Client connected: ${message.clientId}`);
          } else if (message.type === "open_tunnel") {
            // One allocation per socket, including while authentication is pending.
            if (opening || tunnelId || closed) {
              ws.close(1008, "Only one tunnel is allowed per connection");
              return;
            }
            opening = true;
            ownsOpening = true;
            const tunnelProtocol = message.protocol ?? "http";
            if (!["http", "tcp", "udp"].includes(tunnelProtocol)) {
              ws.send(Protocol.encode({ type: "error", code: "INVALID_PROTOCOL", message: "Unsupported tunnel protocol" }));
              ws.close(1008, "Unsupported tunnel protocol");
              return;
            }
            let identity: Awaited<ReturnType<WSHandler["validateAuthToken"]>> = { valid: false };
            if (message.apiKey !== undefined) {
              if (typeof message.apiKey !== "string" || !message.apiKey.trim() || message.apiKey.length > 512) {
                ws.send(Protocol.encode({ type: "error", code: "AUTH_FAILED", message: "Invalid authentication credential" }));
                ws.close(1008, "Authentication failed");
                return;
              }
              identity = await this.validateAuthToken(message.apiKey);
              if (identity?.valid !== true || typeof identity.organizationId !== "string" || !identity.organizationId.trim()) {
                ws.send(Protocol.encode({ type: "error", code: "AUTH_FAILED", message: identity?.error || "Authentication failed" }));
                ws.close(1008, "Authentication failed");
                return;
              }
            } else {
              if (tunnelProtocol !== "http" || message.customDomain || message.password || message.forceTakeover) {
                ws.send(Protocol.encode({ type: "error", code: "AUTH_REQUIRED", message: "Authentication required for this tunnel feature" }));
                ws.close(1008, "Authentication required");
                return;
              }
              const ip = guestClientIp(request, config.tunnelTrustedProxyIps);
              if (!ip) throw new Error("Guest client address unavailable");
              guestLease = await this.guestLimits.admit(ip);
              if (!guestLease) {
                ws.send(Protocol.encode({ type: "error", code: "RATE_LIMITED", message: "Guest limit reached: one active HTTP tunnel per IP and five starts per minute. Try later or run outray login." }));
                ws.close(1008, "Guest tunnel limit reached");
                return;
              }
            }
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            activeProtocol = tunnelProtocol;
            const { organizationId, userId, bandwidthLimit, retentionDays, plan, fullCaptureEnabled } = identity;

            // Gate password protection: only paid plans can use --password
            if (message.password && (!plan || plan === "free")) {
              ws.send(
                Protocol.encode({
                  type: "error",
                  code: "PASSWORD_REQUIRES_PAID",
                  message:
                    "Password-protected tunnels require a paid plan. Upgrade at https://outray.co/pricing",
                }),
              );
              ws.close();
              return;
            }

            if (tunnelProtocol === "tcp" || tunnelProtocol === "udp") {
              const proxy = tunnelProtocol === "tcp" ? this.tcpProxy : this.udpProxy;
              const tunnelName = generateSubdomain();
              allocated.add(tunnelName);
              const result = await proxy.createTunnel(tunnelName, ws, organizationId!, message.remotePort, bandwidthLimit);
              if (!result.success) {
                ws.send(Protocol.encode({ type: "error", code: "TUNNEL_UNAVAILABLE", message: result.error || "Failed to create tunnel" }));
                ws.close();
                return;
              }
              const metadata = { organizationId, userId, bandwidthLimit, retentionDays, plan, fullCaptureEnabled };
              if (!await this.router.reserveTunnel(tunnelName, ws, metadata)) {
                ws.close(1011, "Unable to persist tunnel reservation");
                return;
              }
              const url = `${tunnelProtocol}://${tunnelName}.${config.baseDomain}:${result.port}`;
              const dbResult = await this.registerTunnelInDatabase(userId, organizationId!, url, {
                protocol: tunnelProtocol, remotePort: result.port, tunnelId: tunnelName, name: tunnelName,
              });
              if (!dbResult.success || !dbResult.tunnelId) {
                ws.send(Protocol.encode({ type: "error", code: "REGISTRATION_FAILED", message: dbResult.error || "Failed to register tunnel" }));
                ws.close();
                return;
              }
              proxy.setDbTunnelId(tunnelName, dbResult.tunnelId);
              const reserved = await this.router.registerTunnel(tunnelName, ws, { ...metadata, dbTunnelId: dbResult.tunnelId });
              if (!reserved) {
                ws.close(1011, "Unable to persist tunnel reservation");
                return;
              }
              tunnelId = tunnelName;
              extWs.tunnelId = tunnelName;
              await countOpening(organizationId, tunnelProtocol);
              if (closed || ws.readyState !== WebSocket.OPEN) return;
              ws.send(Protocol.encode({ type: "tunnel_opened", tunnelId, url, protocol: tunnelProtocol, port: result.port, plan }));
              return;
            }

            // Check if custom domain is requested
            if (message.customDomain) {
              if (!organizationId) {
                ws.send(
                  Protocol.encode({
                    type: "error",
                    code: "AUTH_REQUIRED",
                    message: "Authentication required for custom domains",
                  }),
                );
                ws.close();
                return;
              }

              // Verify custom domain belongs to organization
              const domainCheck = await this.verifyCustomDomain(
                message.customDomain,
                organizationId,
              );

              if (!domainCheck.valid) {
                ws.send(
                  Protocol.encode({
                    type: "error",
                    code: "DOMAIN_NOT_VERIFIED",
                    message: domainCheck.error || "Custom domain not verified",
                  }),
                );
                ws.close();
                return;
              }

              // Use custom domain as tunnel ID
              tunnelId = message.customDomain;
              extWs.tunnelId = message.customDomain; // Track for heartbeat logging
              const tunnelUrl = `https://${message.customDomain}`;
              allocated.add(message.customDomain);
              if (!await this.router.reserveTunnel(message.customDomain, ws, {
                organizationId, userId, bandwidthLimit, retentionDays, plan, fullCaptureEnabled, password: message.password,
              }, message.forceTakeover || false)) {
                ws.send(Protocol.encode({ type: "error", code: "DOMAIN_IN_USE", message: "Custom domain is already in use" }));
                ws.close();
                return;
              }

              // Register tunnel in database and check limits
              let dbTunnelId: string | undefined;
              if (organizationId) {
                const result = await this.registerTunnelInDatabase(
                  userId,
                  organizationId,
                  tunnelUrl,
                  {
                    name: message.customDomain,
                  },
                );
                if (!result.success || !result.tunnelId) {
                  ws.send(
                    Protocol.encode({
                      type: "error",
                      code: "REGISTRATION_FAILED",
                      message: result.error || "Failed to register tunnel",
                    }),
                  );
                  ws.close();
                  return;
                }
                dbTunnelId = result.tunnelId;
              }

              const registered = await this.router.registerTunnel(
                message.customDomain,
                ws,
                {
                  organizationId,
                  userId,
                  dbTunnelId,
                  bandwidthLimit,
                  plan,
                  fullCaptureEnabled,
                  password: message.password,
                },
              );

              if (!registered) {
                ws.send(
                  Protocol.encode({
                    type: "error",
                    code: "DOMAIN_IN_USE",
                    message: "Custom domain is already in use",
                  }),
                );
                ws.close();
                return;
              }

              await countOpening(organizationId, "http");
              if (closed || ws.readyState !== WebSocket.OPEN) return;
              ws.send(
                Protocol.encode({
                  type: "tunnel_opened",
                  tunnelId,
                  url: tunnelUrl,
                  plan,
                }),
              );
              console.log(`Tunnel opened with custom domain: ${tunnelId}`);
              return;
            }

            let requestedSubdomain = message.subdomain;
            let reservationAcquired = false;

            const reserve = async (subdomain: string) => {
              allocated.add(`${subdomain}.${config.baseDomain}`);
              const result = await this.reserveSubdomain(subdomain, ws, {
                organizationId, userId, bandwidthLimit, retentionDays, fullCaptureEnabled,
                ...guestLease, password: message.password,
              }, message.forceTakeover || false);
              return result;
            };
            if (requestedSubdomain) {
              const result = await reserve(requestedSubdomain);
              if (!result.reserved) {
                ws.send(Protocol.encode({ type: "error", code: result.code || "TUNNEL_UNAVAILABLE", message: result.error || "Tunnel address unavailable" }));
                ws.close();
                return;
              }
              reservationAcquired = true;
            } else {
              for (let attempt = 0; attempt < 6 && !closed; attempt++) {
                const candidate = attempt === 5 ? `tunnel-${randomUUID()}` : generateSubdomain();
                const result = await reserve(candidate);
                if (result.reserved) {
                  requestedSubdomain = candidate;
                  reservationAcquired = true;
                  break;
                }
              }
            }

            if (!reservationAcquired || !requestedSubdomain) {
              ws.send(
                Protocol.encode({
                  type: "error",
                  code: "TUNNEL_UNAVAILABLE",
                  message:
                    "Unable to allocate a tunnel at this time. Please try again.",
                }),
              );
              ws.close();
              return;
            }

            tunnelId = requestedSubdomain;

            // Construct the tunnel URL and full hostname
            const protocol =
              config.baseDomain === "localhost.direct" ? "http" : "https";
            const portSuffix =
              config.baseDomain === "localhost.direct" ? `:${config.port}` : "";
            const fullHostname = `${tunnelId}.${config.baseDomain}`;
            const tunnelUrl = `${protocol}://${fullHostname}${portSuffix}`;

            // Register tunnel in database and check limits
            let dbTunnelId: string | undefined;
            if (organizationId) {
              const result = await this.registerTunnelInDatabase(
                userId,
                organizationId,
                tunnelUrl,
                {
                  name: requestedSubdomain,
                },
              );
              if (!result.success || !result.tunnelId) {
                ws.send(
                  Protocol.encode({
                    type: "error",
                    code: "LIMIT_EXCEEDED",
                    message: result.error || "Failed to register tunnel",
                  }),
                );
                ws.close();
                return;
              }
              dbTunnelId = result.tunnelId;
            }

            // Use full hostname as tunnel ID for consistency
            const registered = await this.router.registerTunnel(
              fullHostname,
              ws,
              {
                organizationId,
                userId,
                dbTunnelId,
                ...guestLease,
                bandwidthLimit,
                retentionDays,
                plan,
                fullCaptureEnabled,
                password: message.password,
              },
            );

            if (!registered) {
              await this.router.unregisterTunnel(fullHostname, ws);
              tunnelId = null;
              ws.send(
                Protocol.encode({
                  type: "error",
                  code: "TUNNEL_UNAVAILABLE",
                  message: "Unable to persist tunnel reservation.",
                }),
              );
              ws.close();
              return;
            }

            // Update tunnelId to full hostname for message routing
            tunnelId = fullHostname;
            extWs.tunnelId = fullHostname; // Track for heartbeat logging

            const response = Protocol.encode({
              type: "tunnel_opened",
              tunnelId: fullHostname,
              url: tunnelUrl,
              plan,
            });

            await countOpening(organizationId, "http");
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            ws.send(response);
            console.log(`Tunnel opened: ${fullHostname}`);
          } else if (message.type === "tcp_data" && tunnelId && activeProtocol === "tcp") {
            // Handle TCP data from client (response to external connection)
            const tcpMessage = message as TCPDataMessage;
            const data = Buffer.from(tcpMessage.data, "base64");
            this.tcpProxy.handleClientData(tcpMessage.connectionId, data);
          } else if (message.type === "tcp_close" && tunnelId && activeProtocol === "tcp") {
            // Handle TCP close from client
            const tcpMessage = message as TCPCloseMessage;
            this.tcpProxy.handleClientClose(tcpMessage.connectionId);
          } else if (message.type === "udp_response" && tunnelId && activeProtocol === "udp") {
            // Handle UDP response from client
            const udpMessage = message as UDPResponseMessage;
            this.udpProxy.handleClientResponse(udpMessage);
          } else if (message.type === "ws_upgrade_response" && tunnelId && this.wsProxy) {
            // Handle WebSocket upgrade response from client
            this.wsProxy.handleUpgradeResponse(message as WSUpgradeResponseMessage, ws);
          } else if (message.type === "ws_frame" && tunnelId && this.wsProxy) {
            // Handle WebSocket frame from client's local WS
            this.wsProxy.handleFrame(message as WSFrameMessage, ws);
          } else if (message.type === "ws_close" && tunnelId && this.wsProxy) {
            // Handle WebSocket close from client's local WS
            this.wsProxy.handleClose(message as WSCloseMessage, ws);
          } else if (tunnelId) {
            this.router.handleMessage(tunnelId, message);
          }
        } catch (error) {
          console.error("WebSocket message error:", error);
          ws.close(1011, "Tunnel operation failed");
        } finally {
          if (ownsOpening) opening = false;
          if (closed || ws.readyState !== WebSocket.OPEN) {
            await cleanup().catch((error) => console.error("Tunnel cleanup failed:", error));
          }
        }
      });

      ws.on("close", () => {
        closed = true;
        tunnelId = null;
        if (guestLease) void this.guestLimits.release(guestLease).catch((error) => console.error("Guest cleanup failed:", error));
        void cleanup().catch((error) => console.error("Tunnel cleanup failed:", error));
      });

      ws.on("error", (error) => {
        console.error("WebSocket error:", error);
      });
    });
  }
}
