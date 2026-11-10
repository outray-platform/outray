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
