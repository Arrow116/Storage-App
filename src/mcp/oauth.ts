/**
 * A minimal OAuth 2.1 authorization server for the MCP endpoint: discovery metadata,
 * dynamic client registration, authorization code + PKCE, and refresh tokens.
 * The "account" is the app's single login, so approving a client means typing the
 * app username and password on the authorization page.
 */
import { randomUUID } from "node:crypto";
import { checkCredentials, loginLimiter, safeEqual } from "../auth.ts";
import { config } from "../config.ts";
import { SECURITY_HEADERS, clientAddress, publicOrigin } from "../http.ts";
import { open, seal, sha256 } from "./tokens.ts";

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 120;
const SCOPE = "storage";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

interface ClientRecord extends Record<string, unknown> {
  redirect_uris: string[];
  client_name: string;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...SECURITY_HEADERS, ...CORS, "Cache-Control": "no-store", ...headers } });
}

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

// ---------- access tokens ----------

export function isAuthorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const token = match[1]!.trim();
  if (config.mcp.token && safeEqual(token, config.mcp.token)) return true;
  return open("access", token) !== null;
}

export function unauthorized(req: Request, url: URL): Response {
  const metadata = `${publicOrigin(req, url)}/.well-known/oauth-protected-resource/mcp`;
  return json({ error: "unauthorized" }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${metadata}", scope="${SCOPE}"`,
  });
}

function issueTokens(): Response {
  return json({
    access_token: seal("access", { jti: randomUUID() }, ACCESS_TTL),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: seal("refresh", { jti: randomUUID() }, REFRESH_TTL),
    scope: SCOPE,
  });
}

// ---------- redirect URIs ----------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"]);

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1000) return false;
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    return false;
  }
  if (uri.hash) return false;
  if (uri.protocol === "https:") return true;
  if (uri.protocol === "http:") return LOOPBACK.has(uri.hostname);
  return !BLOCKED_SCHEMES.has(uri.protocol); // native-app schemes such as cursor://
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    if (a.protocol !== "http:" || b.protocol !== "http:") return false;
    if (!LOOPBACK.has(a.hostname) || a.hostname !== b.hostname) return false;
    return a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

// ---------- authorization page ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect to Storage</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body><main class="login">${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // No form-action restriction: the form's response redirects to the client's callback.
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const errorPage = (message: string, status = 400) =>
  page(`<div class="card"><h1>Cannot connect</h1><p class="error">${esc(message)}</p></div>`, status);

const AUTHORIZE_FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"];

function authorizeForm(params: URLSearchParams, client: ClientRecord, error?: string): Response {
  const hidden = AUTHORIZE_FIELDS.filter((name) => params.has(name))
    .map((name) => `<input type="hidden" name="${name}" value="${esc(params.get(name)!)}" />`)
    .join("");
  const redirect = new URL(params.get("redirect_uri")!);
  const destination = redirect.host || redirect.protocol;
  const access = config.mcp.readOnly ? "list, read and share your files" : "list, read, share, upload and delete your files";
  return page(
    `<form class="card" method="post" action="/oauth/authorize">
      <h1>Connect to Storage</h1>
      <p><strong>${esc(client.client_name)}</strong> wants to ${access}.</p>
      <p class="muted">After you approve, you are sent back to <strong>${esc(destination)}</strong>. Only continue if you started this connection yourself.</p>
      ${hidden}
      <label>Username <input name="username" autocomplete="username" required autofocus /></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      <button class="primary" type="submit">Approve and connect</button>
    </form>`,
    error ? 401 : 200,
  );
}

function redirectWith(redirectUri: string, params: Record<string, string | null>): Response {
  const target = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) target.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { ...SECURITY_HEADERS, Location: target.toString(), "Cache-Control": "no-store" } });
}

const usedCodes = new Map<string, number>(); // jti -> expiry (ms); codes are single-use

async function authorize(req: Request, url: URL, server: Bun.Server<unknown>): Promise<Response> {
  let params = url.searchParams;
  let form: URLSearchParams | null = null;
  if (req.method === "POST") {
    form = new URLSearchParams(await req.text());
    params = form;
  }

  // Until the client and redirect URI are verified, errors must be shown here, not redirected.
  const client = open<ClientRecord>("client", params.get("client_id"));
  if (!client) return errorPage("Unknown client. Remove the connector in your AI app and add it again.");
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri || !validRedirectUri(redirectUri) || !client.redirect_uris.some((r) => redirectMatches(r, redirectUri))) {
    return errorPage("The redirect address does not match the one this client registered.");
  }

  const state = params.get("state");
  if (params.get("response_type") !== "code") {
    return redirectWith(redirectUri, { error: "unsupported_response_type", state });
  }
  const challenge = params.get("code_challenge");
  if (!challenge || params.get("code_challenge_method") !== "S256") {
    return redirectWith(redirectUri, { error: "invalid_request", error_description: "PKCE with S256 is required", state });
  }

  if (!form) return authorizeForm(params, client);

  const address = clientAddress(req, server);
  if (loginLimiter.isBlocked(address)) return authorizeForm(params, client, "Too many failed attempts. Try again later.");
  if (!checkCredentials({ username: form.get("username"), password: form.get("password") }, config)) {
    loginLimiter.recordFailure(address);
    return authorizeForm(params, client, "Wrong username or password");
  }
  loginLimiter.reset(address);

  const code = seal(
    "code",
    { jti: randomUUID(), client: sha256(params.get("client_id")!), redirect: redirectUri, challenge },
    CODE_TTL,
  );
  return redirectWith(redirectUri, { code, state });
}

// ---------- token + registration ----------

async function token(req: Request): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  let params: URLSearchParams;
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    params = new URLSearchParams(body);
  } else {
    params = new URLSearchParams(await req.text());
  }

  const grant = params.get("grant_type");
  if (grant === "refresh_token") {
    if (!open("refresh", params.get("refresh_token"))) return oauthError("invalid_grant", "Refresh token is invalid or expired");
    return issueTokens();
  }
  if (grant !== "authorization_code") return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");

  const code = open<{ jti: string; client: string; redirect: string; challenge: string; exp: number }>("code", params.get("code"));
  if (!code) return oauthError("invalid_grant", "Authorization code is invalid or expired");
  const now = Date.now();
  for (const [jti, exp] of usedCodes) if (exp <= now) usedCodes.delete(jti);
  if (usedCodes.has(code.jti)) return oauthError("invalid_grant", "Authorization code was already used");

  const clientId = params.get("client_id");
  if (!clientId || sha256(clientId) !== code.client) return oauthError("invalid_grant", "client_id does not match");
  const redirectUri = params.get("redirect_uri");
  if (redirectUri && redirectUri !== code.redirect) return oauthError("invalid_grant", "redirect_uri does not match");
  const verifier = params.get("code_verifier");
  if (!verifier || !safeEqual(sha256(verifier), code.challenge)) return oauthError("invalid_grant", "PKCE verification failed");

  usedCodes.set(code.jti, code.exp * 1000);
  return issueTokens();
}

async function register(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be https, loopback http, or app-scheme URLs");
  }
  const name = typeof body?.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "An MCP client";
  const record: ClientRecord = { redirect_uris: uris as string[], client_name: name };
  return json(
    {
      client_id: seal("client", record),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...record,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

// ---------- router ----------

export async function handleOAuthRoutes(req: Request, url: URL, server: Bun.Server<unknown>): Promise<Response | null> {
  const origin = publicOrigin(req, url);
  const path = url.pathname;
  const known =
    path.startsWith("/.well-known/oauth-") || path === "/.well-known/openid-configuration" || path.startsWith("/oauth/");
  if (!known) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    return json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_name: "Storage",
    });
  }
  if (req.method === "GET" && (path.startsWith("/.well-known/oauth-authorization-server") || path === "/.well-known/openid-configuration")) {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
    });
  }
  if (path === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) return authorize(req, url, server);
  if (path === "/oauth/token" && req.method === "POST") return token(req);
  if (path === "/oauth/register" && req.method === "POST") return register(req);
  return null;
}

export { CORS };
