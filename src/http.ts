import { config } from "./config.ts";

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function clientAddress(req: Request, server: Bun.Server<unknown>): string {
  if (config.trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
    if (forwarded) return forwarded;
  }
  return server.requestIP(req)?.address ?? "unknown";
}

/** The externally visible origin of this app, e.g. `https://files.example.com`. */
export function publicOrigin(req: Request, url: URL): string {
  if (config.publicUrl) return config.publicUrl;
  if (config.trustProxy) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? req.headers.get("host");
    if (proto && host) return `${proto}://${host}`;
  }
  return url.origin;
}
