/** Edge routing flags only; limits and entitlements are enforced by the control plane. */
export function instanceConfig(env: Record<string, string | undefined> = process.env) {
  const mode = env.OUTRAY_DEPLOYMENT_MODE || "hosted";
  if (!["hosted", "self-hosted"].includes(mode)) throw new Error("OUTRAY_DEPLOYMENT_MODE must be hosted or self-hosted");
  const known = ["tunnels", "observability", "secrets", "uptime"];
  const products = env.OUTRAY_PRODUCTS === undefined ? known : env.OUTRAY_PRODUCTS.split(",").map(item => item.trim()).filter(Boolean);
  if (products.some(item => !known.includes(item))) throw new Error("OUTRAY_PRODUCTS contains an unknown product");
  return { selfHosted: mode === "self-hosted", products: [...new Set(products)] };
}
export default { instanceConfig };
