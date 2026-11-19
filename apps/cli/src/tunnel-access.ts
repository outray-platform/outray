export type TunnelAccess = "public" | "password" | "organization";

export type AccessOptions =
  | { ok: true; access?: TunnelAccess; accessBypass?: string[] }
  | { ok: false; error: string };

const ALIASES: Record<string, TunnelAccess> = {
  public: "public",
  password: "password",
  org: "organization",
  organization: "organization",
};

const CLI_LABELS = { access: "--access", bypass: "--access-bypass", password: "--password" };
export const TOML_LABELS = { access: "access", bypass: "access_bypass", password: "password" };

/** Mirrors the edge's rules so mistakes fail before a connection is opened. */
export function resolveAccessOptions(input: {
  access?: string;
  accessBypass?: string[];
  password?: string;
  protocol: "http" | "tcp" | "udp";
}, labels = CLI_LABELS): AccessOptions {
  const { access: A, bypass: B, password: P } = labels;
  let access: TunnelAccess | undefined;
  if (input.access !== undefined) {
    access = ALIASES[input.access.trim().toLowerCase()];
    if (!access) return { ok: false, error: `${A} must be one of: public, password, org` };
  }
  if (access === "organization" && input.password) {
    return { ok: false, error: `${A} org and ${P} cannot be used together` };
  }
  if (access === "password" && !input.password) return { ok: false, error: `${A} password requires ${P}` };
  if (access === "public" && input.password) return { ok: false, error: `${P} cannot be used with ${A} public` };
  const accessBypass = (input.accessBypass ?? []).flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
  if (accessBypass.length && access !== "organization") {
    return { ok: false, error: `${B} requires ${A} org` };
  }
  for (const prefix of accessBypass) {
    if (!prefix.startsWith("/") || prefix === "/" || /[?#%\\\s]/.test(prefix) || prefix.includes("//") ||
        prefix.split("/").some(segment => segment === "." || segment === "..")) {
      return { ok: false, error: `Invalid ${B} path "${prefix}". Use a plain absolute path such as /webhooks` };
    }
  }
  if (access === "organization" && input.protocol !== "http") {
    return { ok: false, error: `${A} org is available only for HTTP tunnels` };
  }
  return { ok: true, access, accessBypass: accessBypass.length ? accessBypass : undefined };
}
