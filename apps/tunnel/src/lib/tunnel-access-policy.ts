export type TunnelAccessMode = "public" | "password" | "organization";

export const ACCESS_MODES: readonly TunnelAccessMode[] = ["public", "password", "organization"];
export const MAX_ACCESS_BYPASS_PREFIXES = 10;
export const ACCESS_CALLBACK_PATH = "/_outray/callback";
const RESERVED_PREFIX = "/_outray";

export type AccessPolicyResult =
  | { ok: true; access: TunnelAccessMode; accessBypass?: string[] }
  | { ok: false; code: string; message: string };

// No ";": servlet containers treat "..;" as a dot segment.
const PATH_CHARS = /^\/[A-Za-z0-9._~!$&'()*+,=:@/-]*$/;

function hasDotSegment(path: string): boolean {
  return path.split("/").some(segment => segment === "." || segment === "..");
}

/** Bypass prefixes are compared against raw request paths, so only plain, unambiguous paths are accepted. */
export function normalizeBypassPrefix(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 2 || value.length > 128) return undefined;
  if (!PATH_CHARS.test(value) || value.includes("//") || hasDotSegment(value)) return undefined;
  const prefix = value.replace(/\/+$/, "");
  if (!prefix || prefix === RESERVED_PREFIX || prefix.startsWith(`${RESERVED_PREFIX}/`)) return undefined;
  return prefix;
}

/**
 * Encoded separators, backslashes, matrix parameters and dot segments are never
 * bypassed: the local app may normalize them into a path outside the allowed prefix.
 */
export function matchesBypass(rawUrl: string | undefined, prefixes: readonly string[] | undefined): boolean {
  if (!prefixes?.length || !rawUrl?.startsWith("/")) return false;
  const path = rawUrl.split(/[?#]/, 1)[0];
  if (/%(?:2e|2f|3b|5c)/i.test(path) || /[\\;]/.test(path) || path.includes("//") || hasDotSegment(path)) return false;
  return prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export function resolveTunnelAccess(message: {
  access?: unknown;
  accessBypass?: unknown;
  password?: unknown;
}, context: { authenticated: boolean; protocol: string; plan?: string }): AccessPolicyResult {
  const invalid = (text: string): AccessPolicyResult => ({ ok: false, code: "INVALID_ACCESS", message: text });
  const requested = message.access ?? (message.password ? "password" : "public");
  if (typeof requested !== "string" || !ACCESS_MODES.includes(requested as TunnelAccessMode)) {
    return invalid("Access must be one of: public, password, organization");
  }
  const access = requested as TunnelAccessMode;
  if (access === "organization" && message.password) {
    return invalid("Organization access and password protection cannot be combined");
  }
  if (access === "password" && !message.password) return invalid("Password access requires a password");
  if (access === "public" && message.password) return invalid("A password requires password access");

  let accessBypass: string[] | undefined;
  if (message.accessBypass !== undefined && message.accessBypass !== null) {
    if (access !== "organization") return invalid("Access bypass paths apply only to organization access");
    if (!Array.isArray(message.accessBypass) || message.accessBypass.length > MAX_ACCESS_BYPASS_PREFIXES) {
      return invalid(`Provide at most ${MAX_ACCESS_BYPASS_PREFIXES} access bypass paths`);
    }
    const normalized = message.accessBypass.map(normalizeBypassPrefix);
    if (normalized.some(prefix => prefix === undefined)) {
      return invalid("Access bypass paths must be plain absolute paths such as /webhooks");
    }
    accessBypass = [...new Set(normalized as string[])];
    if (!accessBypass.length) accessBypass = undefined;
  }

  if (access === "organization") {
    if (!context.authenticated) {
      return { ok: false, code: "AUTH_REQUIRED", message: "Organization access requires an organization login. Run outray login." };
    }
    if (context.protocol !== "http") return invalid("Organization access is available only for HTTP tunnels");
    if (!context.plan || context.plan === "free") {
      return {
        ok: false,
        code: "ORG_ACCESS_REQUIRES_PAID",
        message: "Organization-only tunnels require a paid plan. Upgrade at https://outray.co/pricing",
      };
    }
  }
  return { ok: true, access, ...(accessBypass ? { accessBypass } : {}) };
}

/** Only same-host relative paths may be used as a post-login destination. */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.length > 2048) return undefined;
  if (/[\\\s\p{Cc}]/u.test(value) || /^\/%(?:2f|5c)/i.test(value)) return undefined;
  try {
    const base = "https://tunnel.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return undefined;
    if (url.pathname === ACCESS_CALLBACK_PATH || url.pathname.startsWith(`${RESERVED_PREFIX}/`)) return undefined;
  } catch {
    return undefined;
  }
  return value;
}
