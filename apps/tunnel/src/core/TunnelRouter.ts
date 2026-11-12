import WebSocket from "ws";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { Protocol, RequestMessage, ResponseMessage, Message } from "./Protocol";
import { generateId } from "../../../../shared/utils";

interface PendingRequest {
  resolve: (response: ResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  tunnelId: string;
}

interface TunnelRouterOptions {
  redis?: Redis;
  subRedis?: Redis;
  ttlSeconds?: number;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
}

export interface TunnelMetadata {
  organizationId?: string;
  userId?: string;
  dbTunnelId?: string;
  bandwidthLimit?: number;
  retentionDays?: number;
  plan?: string;
  fullCaptureEnabled?: boolean;
  password?: string;
}

export class TunnelRouter {
  private tunnels = new Map<string, WebSocket>();
  private tunnelMetadata = new Map<string, TunnelMetadata>();
  private pendingRequests = new Map<string, PendingRequest>();
  private redis?: Redis;
  private readonly serverId = generateId("tunnel-server");
  private readonly ttlSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private heartbeatTimer?: NodeJS.Timeout;
  private refreshing = false;
  private connectionIds = new WeakMap<WebSocket, string>();

  constructor(options: TunnelRouterOptions = {}) {
    this.redis = options.redis;
    this.ttlSeconds = Math.max(30, options.ttlSeconds ?? 120);
    this.heartbeatIntervalMs = Math.max(
      5000,
      options.heartbeatIntervalMs ?? 20000,
    );
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000;

    if (this.redis) {
      this.startHeartbeat();
    }

    if (options.subRedis) {
      options.subRedis.subscribe("tunnel:control", (err) => {
        if (err) console.error("Failed to subscribe to tunnel:control", err);
      });
      options.subRedis.on("message", (channel, message) => {
        if (channel === "tunnel:control") {
          this.handleControlMessage(message);
        }
      });
    }
  }

  private handleControlMessage(message: string) {
    if (message.startsWith("kill:")) {
      const tunnelId = message.split(":")[1];
      const ws = this.tunnels.get(tunnelId);
      if (ws) {
        console.log(`Received kill command for tunnel ${tunnelId}`);
        void this.unregisterTunnel(tunnelId, ws);
        ws.terminate();
      }
      return;
    }

    try {
      const controlMessage = JSON.parse(message) as {
        type?: string;
        organizationId?: string;
        enabled?: boolean;
      };

      if (
        controlMessage.type !== "full_capture_setting" ||
        !controlMessage.organizationId ||
        typeof controlMessage.enabled !== "boolean"
      ) {
        return;
      }

      let updatedTunnels = 0;
      for (const [tunnelId, metadata] of this.tunnelMetadata.entries()) {
        if (metadata.organizationId !== controlMessage.organizationId) {
          continue;
        }

        this.tunnelMetadata.set(tunnelId, {
          ...metadata,
          fullCaptureEnabled: controlMessage.enabled,
        });
        updatedTunnels += 1;
      }

      console.log(
        `Updated full capture setting for ${updatedTunnels} active tunnel(s) in organization ${controlMessage.organizationId}`,
      );
    } catch {
      // Ignore control messages owned by older or unrelated producers.
    }
  }

  getRedis(): Redis | undefined {
    return this.redis;
  }

  async registerTunnel(
    tunnelId: string,
    ws: WebSocket,
    metadata?: TunnelMetadata,
  ): Promise<boolean> {
    if (this.tunnels.get(tunnelId) !== ws) {
      if (ws.readyState !== WebSocket.OPEN) {
        await this.releaseTunnelState(tunnelId, ws, metadata);
        return false;
      }
      return this.reserveTunnel(tunnelId, ws, metadata);
    }
    if (metadata) this.tunnelMetadata.set(tunnelId, metadata);
    if (ws.readyState !== WebSocket.OPEN) {
      await this.unregisterTunnel(tunnelId, ws);
      return false;
    }
    const persisted = await this.persistTunnelState(tunnelId, "XX", ws, metadata);
    if (!persisted || ws.readyState !== WebSocket.OPEN) {
      await this.unregisterTunnel(tunnelId, ws);
      return false;
    }
    return true;
  }

  async unregisterTunnel(tunnelId: string, ws: WebSocket): Promise<void> {
    if (this.tunnels.get(tunnelId) !== ws) return;
    const metadata = this.tunnelMetadata.get(tunnelId);
    this.tunnels.delete(tunnelId);
    this.tunnelMetadata.delete(tunnelId);
    for (const [requestId, req] of this.pendingRequests) {
      if (req.tunnelId === tunnelId) {
        clearTimeout(req.timeout);
        this.pendingRequests.delete(requestId);
        req.reject(new Error("Tunnel disconnected"));
      }
    }
    await this.releaseTunnelState(tunnelId, ws, metadata);
  }

  private async releaseTunnelState(tunnelId: string, ws: WebSocket, metadata?: TunnelMetadata): Promise<void> {
    if (!this.redis) return;
    try {
      // One atomic release, guarded by connection identity. A delayed close on
      // an old edge must not delete a replacement tunnel or its online status.
      await this.redis.eval(`
        local raw = redis.call('GET', KEYS[1])
        if raw then
          local ok, current = pcall(cjson.decode, raw)
          if not ok or type(current) ~= 'table' or current.connectionId ~= ARGV[1] then return 0 end
        end
        redis.call('DEL', KEYS[1])
        if ARGV[2] ~= '' and ARGV[3] ~= '' then
          redis.call('SREM', KEYS[2], ARGV[3])
          redis.call('DEL', KEYS[3])
          if redis.call('SCARD', KEYS[2]) == 0 then
            redis.call('SREM', KEYS[4], ARGV[2])
          end
        end
        return 1
      `, 4, this.redisKey(tunnelId), `org:${metadata?.organizationId}:online_tunnels`,
      `tunnel:last_seen:${metadata?.dbTunnelId}`, "global:orgs_with_online_tunnels",
      this.connectionId(ws), metadata?.organizationId || "", metadata?.dbTunnelId || "");
    } catch (error) {
      // The route and last_seen leases expire even when Redis is unavailable.
      console.error("Failed to remove tunnel reservation", error);
    }
  }

  async reserveTunnel(
    tunnelId: string,
    ws: WebSocket,
    metadata?: TunnelMetadata,
    forceTakeover = false,
  ): Promise<boolean> {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const previous = this.tunnels.get(tunnelId);
    const previousMetadata = this.tunnelMetadata.get(tunnelId);
    if (!this.redis && previous && previous !== ws) {
      const sameOwner = metadata?.userId && metadata.userId === previousMetadata?.userId &&
        metadata.organizationId === previousMetadata?.organizationId;
      if (previous.readyState === WebSocket.OPEN && !(forceTakeover && sameOwner)) return false;
    }
    if (!await this.persistTunnelState(tunnelId, "NX", ws, metadata, forceTakeover)) return false;
    this.tunnels.set(tunnelId, ws);
    if (metadata) this.tunnelMetadata.set(tunnelId, metadata);
    if (previous && previous !== ws) previous.terminate();
    if (ws.readyState !== WebSocket.OPEN) {
      await this.unregisterTunnel(tunnelId, ws);
      return false;
    }
    return true;
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await Promise.all(Array.from(this.tunnels, ([id, ws]) => this.unregisterTunnel(id, ws)));
  }

  getTunnelMetadata(tunnelId: string): TunnelMetadata | undefined {
    return this.tunnelMetadata.get(tunnelId);
  }

  getTunnel(tunnelId: string): WebSocket | undefined {
    return this.tunnels.get(tunnelId);
  }

  hasTunnel(tunnelId: string): boolean {
    return this.tunnels.has(tunnelId);
  }

  handleMessage(tunnelId: string, message: Message): void {
    if (message.type === "response") {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.requestId);
        pending.resolve(message);
      }
    }
  }

  async forwardRequest(
    tunnelId: string,
    method: string,
    path: string,
    headers: Record<string, string | string[]>,
    body?: string,
  ): Promise<ResponseMessage> {
    const ws = this.tunnels.get(tunnelId);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Tunnel not available");
    }

    const requestId = generateId("req");

    const requestMessage: RequestMessage = {
      type: "request",
      requestId,
      method,
      path,
      headers,
      body,
    };

    return new Promise<ResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.error(
          `Request timeout for tunnel ${tunnelId}, request ${requestId}`,
        );
        reject(new Error("Request timeout"));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        tunnelId,
      });

      ws.send(Protocol.encode(requestMessage));
    });
  }

  private redisKey(tunnelId: string): string {
    return `tunnel:online:${tunnelId}`;
  }

  private connectionId(ws: WebSocket): string {
    let id = this.connectionIds.get(ws);
    if (!id) { id = randomUUID(); this.connectionIds.set(ws, id); }
    return id;
  }

  private async persistTunnelState(
    tunnelId: string,
    mode: "NX" | "XX",
    ws: WebSocket,
    metadata?: TunnelMetadata,
    forceTakeover = false,
  ): Promise<boolean> {
    if (!this.redis) return true;
    const value = JSON.stringify({ ...metadata, serverId: this.serverId,
      connectionId: this.connectionId(ws), updatedAt: Date.now() });
    try {
      const result = await this.redis.eval(`
        local raw = redis.call('GET', KEYS[1])
        local incoming = cjson.decode(ARGV[1])
        if raw then
          local ok, current = pcall(cjson.decode, raw)
          if not ok or type(current) ~= 'table' then return 0 end
          if current.connectionId ~= incoming.connectionId then
            if ARGV[3] ~= 'NX' or ARGV[4] ~= 'true' or
              not incoming.userId or not incoming.organizationId or
              current.userId ~= incoming.userId or current.organizationId ~= incoming.organizationId then
              return 0
            end
          end
        elseif ARGV[3] == 'XX' then
          -- A closed/replaced/expired lease must never be resurrected by a heartbeat.
          return 0
        end
        redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
        if incoming.organizationId and incoming.dbTunnelId then
          redis.call('SADD', KEYS[2], incoming.dbTunnelId)
          redis.call('SADD', KEYS[4], incoming.organizationId)
          redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[2])
        end
        return 1
      `, 4, this.redisKey(tunnelId), `org:${metadata?.organizationId}:online_tunnels`,
      `tunnel:last_seen:${metadata?.dbTunnelId}`, "global:orgs_with_online_tunnels",
      value, this.ttlSeconds, mode, String(forceTakeover), Date.now());
      return result === 1;
    } catch (error) {
      console.error("Failed to persist tunnel state", error);
      return false;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.refreshActiveTunnels();
    }, this.heartbeatIntervalMs);

    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  private async refreshActiveTunnels(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all(Array.from(this.tunnels, async ([tunnelId, ws]) => {
        if (ws.readyState !== WebSocket.OPEN ||
            !await this.persistTunnelState(tunnelId, "XX", ws, this.tunnelMetadata.get(tunnelId))) {
          await this.unregisterTunnel(tunnelId, ws);
          ws.terminate();
        }
      }));
    } finally {
      this.refreshing = false;
    }
  }
}
