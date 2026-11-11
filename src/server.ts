import { join } from "node:path";
import {
  LoginLimiter,
  SESSION_COOKIE,
  checkCredentials,
  createSessionToken,
  readCookie,
  sessionCookie,
  verifySessionToken,
} from "./auth.ts";
import { config } from "./config.ts";
import { KeyError, baseName, parseFileKey, parseFolderKey } from "./keys.ts";
import * as storage from "./storage.ts";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
const PAGE_CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const MAX_SHARE_SECONDS = 7 * 24 * 3600; // SigV4 presigned URL limit
const limiter = new LoginLimiter();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...headers } });
}

function clientAddress(req: Request, server: Bun.Server<unknown>): string {
  if (config.trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
    if (forwarded) return forwarded;
  }
  return server.requestIP(req)?.address ?? "unknown";
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "Expected a JSON object body");
}

/** Rejects cross-site state-changing requests (defence in depth on top of SameSite=Strict). */
function checkOrigin(req: Request, url: URL): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Bad origin");
  }
  const host = req.headers.get("host") ?? url.host;
  if (originHost !== host) throw new HttpError(403, "Cross-origin request rejected");
}

function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Types safe to render in the browser from our origin. Everything else is forced to download. */
function canInline(type: string): boolean {
  const mime = type.split(";")[0]!.trim().toLowerCase();
  if (mime === "image/svg+xml") return false;
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf" ||
    mime === "text/plain"
  );
}

function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null; // unsupported form: send the whole file
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

async function download(req: Request, url: URL): Promise<Response> {
  const key = parseFileKey(url.searchParams.get("key"));
  const info = await storage.stat(key);
  const type = info.type || "application/octet-stream";
  const inline = url.searchParams.get("inline") === "1" && canInline(type);
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": type,
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", baseName(key)),
    "Content-Security-Policy": "sandbox; default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Last-Modified": info.lastModified.toUTCString(),
    ETag: info.etag,
  };

  const range = parseRange(req.headers.get("range"), info.size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${info.size}` } });
  }
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${info.size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(req.method === "HEAD" ? null : storage.read(key, range), { status: 206, headers });
  }
  headers["Content-Length"] = String(info.size);
  if (req.method === "HEAD" || info.size === 0) return new Response(null, { headers });
  return new Response(storage.read(key), { headers });
}

async function api(req: Request, url: URL, server: Bun.Server<unknown>): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating) checkOrigin(req, url);

  if (route === "GET /api/health") return json({ ok: true });

  const authenticated = verifySessionToken(readCookie(req, SESSION_COOKIE), config.sessionSecret);

  if (route === "GET /api/session") {
    return json({ authenticated, username: authenticated ? config.username : null });
  }

  if (route === "POST /api/login") {
    const address = clientAddress(req, server);
    if (limiter.isBlocked(address)) throw new HttpError(429, "Too many failed attempts. Try again later.");
    const body = await readJson(req);
    if (!checkCredentials({ username: body.username, password: body.password }, config)) {
      limiter.recordFailure(address);
      throw new HttpError(401, "Wrong username or password");
    }
    limiter.reset(address);
    const token = createSessionToken(config.sessionSecret, config.sessionTtlSeconds);
    return json({ authenticated: true, username: config.username }, 200, {
      "Set-Cookie": sessionCookie(token, config.sessionTtlSeconds, config.cookieSecure),
    });
  }

  if (route === "POST /api/logout") {
    return json({ authenticated: false }, 200, { "Set-Cookie": sessionCookie("", 0, config.cookieSecure) });
  }

  if (!authenticated) throw new HttpError(401, "Not signed in");

  switch (route) {
    case "GET /api/files": {
      const prefix = parseFolderKey(url.searchParams.get("prefix") ?? "", { allowRoot: true });
      return json(await storage.list(prefix));
    }

    case "PUT /api/files": {
      const key = parseFileKey(url.searchParams.get("key"));
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > config.maxUploadBytes) throw new HttpError(413, "File exceeds the upload size limit");
      const type = req.headers.get("content-type") || "application/octet-stream";
      const size = await storage.upload(key, req.body, type, config.maxUploadBytes);
      return json({ key, size }, 201);
    }

    case "DELETE /api/files": {
      const raw = url.searchParams.get("key") ?? "";
      if (raw.endsWith("/")) {
        const removed = await storage.removeFolder(parseFolderKey(raw));
        return json({ removed });
      }
      await storage.removeFile(parseFileKey(raw));
      return json({ removed: 1 });
    }

    case "GET /api/download":
    case "HEAD /api/download":
      return download(req, url);

    case "POST /api/folders": {
      const body = await readJson(req);
      const key = parseFolderKey(body.key);
      await storage.createFolder(key);
      return json({ key }, 201);
    }

    case "POST /api/share": {
      const body = await readJson(req);
      const key = parseFileKey(body.key);
      const expiresIn = Number(body.expiresIn ?? 3600);
      if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > MAX_SHARE_SECONDS) {
        throw new HttpError(400, "expiresIn must be between 60 seconds and 7 days");
      }
      await storage.stat(key); // 404 instead of handing out a link to nothing
      return json({
        url: storage.shareUrl(key, expiresIn),
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      });
    }
  }

  throw new HttpError(404, "Not found");
}

function errorResponse(err: unknown, route: string): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  if (err instanceof KeyError) return json({ error: err.message }, 400);
  if (err instanceof storage.UploadTooLargeError) return json({ error: "File exceeds the upload size limit" }, 413);
  if (storage.isNotFound(err)) return json({ error: "File not found" }, 404);
  console.error(`[error] ${route}:`, err);
  return json({ error: "Storage backend error. Check the server logs." }, 502);
}

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  maxRequestBodySize: config.maxUploadBytes,
  idleTimeout: 255, // seconds; the maximum, so slow large transfers are not cut off
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, url, server);
      } catch (err) {
        return errorResponse(err, `${req.method} ${url.pathname}`);
      }
    }
    const asset = STATIC_FILES[url.pathname];
    if (asset && (req.method === "GET" || req.method === "HEAD")) {
      return new Response(Bun.file(join(PUBLIC_DIR, asset.file)), {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": asset.type,
          "Content-Security-Policy": PAGE_CSP,
          "Cache-Control": "no-cache",
        },
      });
    }
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  },
});

console.log(`Storage app listening on http://0.0.0.0:${server.port}`);
console.log(`Bucket: ${config.s3.bucket}${config.s3.prefix ? ` (prefix ${config.s3.prefix})` : ""}`);
storage.ping().then(
  () => console.log("S3 connection OK"),
  (err) => console.error("WARNING: cannot reach the S3 bucket. Check the S3_* settings.", err),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
