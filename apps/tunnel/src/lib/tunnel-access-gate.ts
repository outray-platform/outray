import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ACCESS_CALLBACK_PATH, matchesBypass, safeReturnPath } from "./tunnel-access-policy";

export interface AccessIdentity {
  host: string;
  userId: string;
  organizationId: string;
}

interface GatedTunnel {
  organizationId?: string;
  accessBypass?: string[];
}

export type AccessDecision =
  | { action: "forward"; identity?: AccessIdentity }
  | { action: "respond"; status: number; headers: Record<string, string | string[]>; body: string };

export interface TunnelAccessGateOptions {
  consoleUrl?: string;
  apiUrl: string;
  internalApiSecret?: string;
  cookieSecret?: string;
  secureCookies: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  revalidateMs?: number;
  sessionMs?: number;
  requestTimeoutMs?: number;
  maxCacheEntries?: number;
}

const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_VERSION = "v1";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function noStore(headers: Record<string, string | string[]> = {}) {
  return { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", ...headers };
}

function respond(status: number, body: string, headers?: Record<string, string | string[]>): AccessDecision {
  return { action: "respond", status, headers: noStore(headers), body };
}

class AccessUnavailableError extends Error {}

/**
 * "Login with OutRay" for organization-only tunnels. Identity lives in a
 * host-only signed cookie; membership is re-checked with the console every
 * revalidation window, and any console failure denies access.
 */
export class TunnelAccessGate {
  private readonly key?: Buffer;
  private readonly consoleUrl?: URL;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly revalidateMs: number;
  private readonly sessionMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxCacheEntries: number;
  private readonly verified = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  readonly cookieName: string;

  constructor(private readonly options: TunnelAccessGateOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.revalidateMs = options.revalidateMs ?? 5 * 60_000;
    this.sessionMs = options.sessionMs ?? 12 * 60 * 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.maxCacheEntries = options.maxCacheEntries ?? 50_000;
    // __Host- pins the cookie to the exact tunnel host: no Domain, Path=/, Secure.
    this.cookieName = options.secureCookies ? "__Host-outray_access" : "outray_access";
    try {
      const url = options.consoleUrl ? new URL(options.consoleUrl) : undefined;
      if (url && ["https:", "http:"].includes(url.protocol)) this.consoleUrl = url;
    } catch {
      this.consoleUrl = undefined;
    }
    const secret = options.cookieSecret || options.internalApiSecret;
    if (secret) {
      // A dedicated subkey keeps cookie signatures independent of the bearer secret.
      this.key = Buffer.from(hkdfSync("sha256", secret, "outray-tunnel-access", "cookie-signing-v1", 32));
    }
  }

  get configured(): boolean {
    return Boolean(this.key && this.consoleUrl && this.options.internalApiSecret);
  }

  async authorizeRequest(req: IncomingMessage, host: string, tunnel: GatedTunnel): Promise<AccessDecision> {
    if (!this.configured || !tunnel.organizationId) return respond(503, "Organization access is unavailable");
    const pathname = (req.url || "/").split("?", 1)[0];
    if (pathname === ACCESS_CALLBACK_PATH) return this.callback(req, host, tunnel.organizationId);
    if (matchesBypass(req.url, tunnel.accessBypass)) return { action: "forward" };

    let identity: AccessIdentity | undefined;
    try {
      identity = await this.identify(req, host, tunnel.organizationId);
    } catch {
      return respond(503, "Organization access check is temporarily unavailable");
    }
    if (identity) return { action: "forward", identity };

    const clear: Record<string, string> = this.hasCookie(req) ? { "Set-Cookie": this.clearCookie() } : {};
    if (!this.isNavigation(req)) {
      return respond(401, "Organization sign-in required", { ...clear, "WWW-Authenticate": 'OutRay realm="organization"' });
    }
    const location = new URL("/tunnel-auth", this.consoleUrl);
    location.search = new URLSearchParams({ host, return: safeReturnPath(req.url) ?? "/" }).toString();
    return respond(302, "Redirecting to OutRay sign-in", { ...clear, Location: location.toString(), "Referrer-Policy": "no-referrer" });
  }

  /** WebSocket upgrades are gated by cookie only: never redirected, never sent through the callback. */
  async authorizeUpgrade(req: IncomingMessage, host: string, tunnel: GatedTunnel): Promise<AccessDecision> {
    if (!this.configured || !tunnel.organizationId) return respond(503, "Organization access is unavailable");
    if (matchesBypass(req.url, tunnel.accessBypass)) return { action: "forward" };
    try {
      const identity = await this.identify(req, host, tunnel.organizationId);
      return identity ? { action: "forward", identity } : respond(401, "Organization sign-in required");
    } catch {
      return respond(503, "Organization access check is temporarily unavailable");
    }
  }

  /** For long-lived connections; any failure, including an unreachable console, revokes. */
  async stillAuthorized(identity: AccessIdentity): Promise<boolean> {
    try {
      return await this.revalidate(identity);
    } catch {
      return false;
    }
  }

  stripCookie(headers: Record<string, string | string[]>): void {
    const value = headers.cookie;
    if (value === undefined) return;
    const kept = (Array.isArray(value) ? value.join("; ") : value)
      .split(";")
      .map(part => part.trim())
      .filter(part => part && part.split("=", 1)[0].trim() !== this.cookieName);
    if (kept.length) headers.cookie = kept.join("; ");
    else delete headers.cookie;
  }

  private async callback(req: IncomingMessage, host: string, organizationId: string): Promise<AccessDecision> {
    // HEAD would let link prefetchers burn the single-use code.
    if (req.method !== "GET") return respond(405, "Method not allowed", { Allow: "GET" });
    const code = new URL(req.url || "/", "https://tunnel.invalid").searchParams.get("code");
    if (!code || !CODE_PATTERN.test(code)) return respond(400, "Invalid sign-in link");

    let result: { valid?: unknown; userId?: unknown; organizationId?: unknown; returnPath?: unknown };
    try {
      const response = await this.post("/tunnel/access/redeem", { code, host });
      if (response.status >= 500) throw new AccessUnavailableError();
      result = await response.json() as typeof result;
      if (!response.ok) result = { valid: false };
    } catch {
      return respond(503, "Organization sign-in is temporarily unavailable");
    }
    if (result?.valid !== true || typeof result.userId !== "string" || !result.userId ||
        typeof result.organizationId !== "string" || !equal(result.organizationId, organizationId)) {
      return respond(403, "This sign-in link is invalid, expired or was already used. Open the tunnel address again to sign in.", { "Referrer-Policy": "no-referrer" });
    }
    const identity = { host, userId: result.userId, organizationId };
    this.remember(identity);
    return respond(302, "Signed in", {
      Location: safeReturnPath(result.returnPath) ?? "/",
      "Set-Cookie": this.issueCookie(identity),
      "Referrer-Policy": "no-referrer",
    });
  }

  private async identify(req: IncomingMessage, host: string, organizationId: string): Promise<AccessIdentity | undefined> {
    const identity = this.readCookie(req, host);
    if (!identity || !equal(identity.organizationId, organizationId)) return undefined;
    return await this.revalidate(identity) ? identity : undefined;
  }

  private async revalidate(identity: AccessIdentity): Promise<boolean> {
    const key = `${identity.host}\n${identity.organizationId}\n${identity.userId}`;
    const checkedAt = this.verified.get(key);
    if (checkedAt !== undefined && this.now() - checkedAt < this.revalidateMs) return true;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await this.post("/tunnel/access/revalidate", identity);
        if (response.status >= 500) throw new AccessUnavailableError();
        const body = await response.json() as { valid?: unknown };
        const valid = response.ok && body?.valid === true;
        if (valid) this.remember(identity);
        else this.verified.delete(key);
        return valid;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private remember(identity: AccessIdentity): void {
    const key = `${identity.host}\n${identity.organizationId}\n${identity.userId}`;
    this.verified.delete(key);
    this.verified.set(key, this.now());
    while (this.verified.size > this.maxCacheEntries) {
      this.verified.delete(this.verified.keys().next().value!);
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetch(`${this.options.apiUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.internalApiSecret}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key!).update(`${COOKIE_VERSION}.${payload}`).digest("base64url");
  }

  private issueCookie(identity: AccessIdentity): string {
    const issuedAt = this.now();
    const payload = Buffer.from(JSON.stringify({
      h: identity.host, u: identity.userId, o: identity.organizationId, iat: issuedAt, exp: issuedAt + this.sessionMs,
    })).toString("base64url");
    const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(this.sessionMs / 1000)}`];
    if (this.options.secureCookies) attributes.push("Secure");
    return `${this.cookieName}=${COOKIE_VERSION}.${payload}.${this.sign(payload)}; ${attributes.join("; ")}`;
  }

  private clearCookie(): string {
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.options.secureCookies ? "; Secure" : ""}`;
  }

  private cookieValues(req: IncomingMessage): string[] {
    const header = req.headers.cookie;
    if (!header) return [];
    return header.split(";").flatMap(part => {
      const index = part.indexOf("=");
      return index !== -1 && part.slice(0, index).trim() === this.cookieName ? [part.slice(index + 1).trim()] : [];
    });
  }

  private hasCookie(req: IncomingMessage): boolean {
    return this.cookieValues(req).length > 0;
  }

  private readCookie(req: IncomingMessage, host: string): AccessIdentity | undefined {
    for (const value of this.cookieValues(req)) {
      const [version, payload, signature] = value.split(".");
      if (version !== COOKIE_VERSION || !payload || !signature || !equal(signature, this.sign(payload))) continue;
      try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof claims.h !== "string" || !equal(claims.h, host)) continue;
        if (typeof claims.exp !== "number" || claims.exp <= this.now()) continue;
        if (typeof claims.u !== "string" || !claims.u || typeof claims.o !== "string" || !claims.o) continue;
        return { host, userId: claims.u, organizationId: claims.o };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private isNavigation(req: IncomingMessage): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const mode = req.headers["sec-fetch-mode"];
    if (typeof mode === "string") return mode === "navigate";
    return String(req.headers.accept || "").includes("text/html");
  }
}
