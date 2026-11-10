export const NEXT_DEV_ORIGINS_DOCS_URL =
  "https://outray.co/docs/nextjs-plugin#allow-the-tunnel-origin";

export function tunnelHostname(tunnelUrl: string): string | null {
  try {
    return new URL(tunnelUrl).hostname || null;
  } catch {
    return null;
  }
}

function matchesDevOrigin(hostname: string, pattern: string): boolean {
  const hostParts = hostname.toLowerCase().split(".");
  const patternParts = pattern.trim().toLowerCase().split(".");
  if (patternParts.length === 1 && patternParts[0].startsWith("*")) return false;

  while (patternParts.length) {
    const part = patternParts.pop()!;
    if (part === "**") return patternParts.length === 0 && hostParts.length > 0;
    const hostPart = hostParts.pop();
    if (!part || hostPart === undefined) return false;
    if (part !== "*" && part !== hostPart) return false;
  }
  return hostParts.length === 0;
}

/** Mirrors Next.js matching: exact hosts, `*` for one label, leading `**` for any depth. */
export function isDevOriginAllowed(
  allowedDevOrigins: readonly string[] | undefined,
  hostname: string,
): boolean {
  return (allowedDevOrigins ?? []).some(
    (pattern) => typeof pattern === "string" && matchesDevOrigin(hostname, pattern),
  );
}

export function formatAllowedDevOriginsHint(hostname: string): string[] {
  return [
    "Next.js 15+ blocks dev assets and HMR from unknown origins, so styles and",
    "hot reload can break through the tunnel. Add the tunnel host to next.config:",
    "",
    "  const nextConfig = {",
    `    allowedDevOrigins: [${JSON.stringify(hostname)}],`,
    "  };",
    "",
    `Then restart next dev. ${NEXT_DEV_ORIGINS_DOCS_URL}`,
  ];
}
