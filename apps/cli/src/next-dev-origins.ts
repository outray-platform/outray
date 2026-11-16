type HeaderValue = string | string[] | number | undefined;

const NEXT_PATH_PREFIXES = ["/_next/", "/__nextjs_"];

export function isNextDevPath(path: string | undefined): boolean {
  return !!path && NEXT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function isNextPoweredBy(value: HeaderValue): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some((entry) => String(entry ?? "").includes("Next.js"));
}

export function isNextDevServer(
  path: string | undefined,
  headers: Record<string, HeaderValue> = {},
): boolean {
  return isNextDevPath(path) || isNextPoweredBy(headers["x-powered-by"]);
}

export const NEXT_DEV_ORIGINS_DOCS_URL =
  "https://outray.co/docs/nextjs-plugin#allow-the-tunnel-origin";

export function tunnelHostname(tunnelUrl: string): string | null {
  try {
    return new URL(tunnelUrl).hostname || null;
  } catch {
    return null;
  }
}

export function formatAllowedDevOriginsHint(tunnelUrl: string): string | null {
  const hostname = tunnelHostname(tunnelUrl);
  if (!hostname) return null;
  return [
    "Next.js detected. Next.js 15+ blocks dev assets and HMR from unknown origins,",
    "so styles and hot reload can break through the tunnel. Add the tunnel host to next.config:",
    "",
    "  const nextConfig = {",
    `    allowedDevOrigins: [${JSON.stringify(hostname)}],`,
    "  };",
    "",
    `Then restart next dev. ${NEXT_DEV_ORIGINS_DOCS_URL}`,
  ].join("\n");
}
