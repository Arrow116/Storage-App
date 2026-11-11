import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "storage_session";

function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function checkCredentials(
  given: { username: unknown; password: unknown },
  expected: { username: string; password: string },
): boolean {
  if (typeof given.username !== "string" || typeof given.password !== "string") return false;
  const userOk = safeEqual(given.username, expected.username);
  const passOk = safeEqual(given.password, expected.password);
  return userOk && passOk;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Token format: `<expiryEpochSeconds>.<hmac>`. */
export function createSessionToken(secret: string, ttlSeconds: number, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  return `${expires}.${sign(String(expires), secret)}`;
}

export function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = token.slice(0, dot);
  if (!/^\d+$/.test(expires)) return false;
  if (!safeEqual(token.slice(dot + 1), sign(expires, secret))) return false;
  return Number(expires) * 1000 > now;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Fixed-window limiter for failed logins, keyed by client address. */
export class LoginLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
