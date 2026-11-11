/**
 * Stateless signed tokens for the MCP OAuth flow. Nothing is stored server-side:
 * every client id, authorization code, access token and refresh token is a signed
 * payload. Changing APP_PASSWORD or SESSION_SECRET invalidates all of them.
 */
import { createHash, createHmac } from "node:crypto";
import { safeEqual } from "../auth.ts";
import { config } from "../config.ts";

export type TokenType = "client" | "code" | "access" | "refresh";

const key = createHmac("sha256", config.sessionSecret).update(`mcp-oauth|${config.password}`).digest();

function mac(type: TokenType, body: string): string {
  return createHmac("sha256", key).update(`${type}.${body}`).digest("base64url");
}

export function seal(type: TokenType, payload: Record<string, unknown>, ttlSeconds?: number): string {
  const full = ttlSeconds ? { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds } : payload;
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${mac(type, body)}`;
}

export function open<T extends Record<string, unknown>>(type: TokenType, token: unknown): T | null {
  if (typeof token !== "string" || token.length > 8192) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), mac(type, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { exp?: number };
    if (payload.exp !== undefined && payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
