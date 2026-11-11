/**
 * Model Context Protocol endpoint (Streamable HTTP transport, stateless).
 * Every JSON-RPC request is answered with a plain JSON response; the server
 * never initiates messages, so no SSE stream or session is needed.
 */
import { SECURITY_HEADERS } from "../http.ts";
import { CORS, handleOAuthRoutes, isAuthorized, unauthorized } from "./oauth.ts";
import { callTool, listTools } from "./tools.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const INSTRUCTIONS =
  "This server gives access to the user's personal file storage. Paths use forward slashes and have no leading slash; " +
  "folders end with a slash. Start with list_files or search_files to find things.";

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...CORS, "Cache-Control": "no-store", ...headers } });
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Returns undefined for notifications and responses, which get no reply. */
async function dispatch(message: RpcRequest): Promise<unknown> {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid JSON-RPC message");
  }
  if (typeof message.method !== "string") return undefined; // a response from the client
  if (message.id === undefined || message.id === null) return undefined; // a notification

  const { id, method, params = {} } = message;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(requested as string) ? requested : PROTOCOL_VERSIONS[0];
      return result({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "storage-app", title: "Storage", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: listTools() });
    case "tools/call": {
      const outcome = await callTool(params.name, params.arguments);
      if (!outcome) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
      return result(outcome);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMcp(req: Request, url: URL): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "POST, OPTIONS" } });
  }
  if (!isAuthorized(req)) return unauthorized(req, url);
  if (req.method !== "POST") {
    // No server-initiated stream (GET) and no sessions to end (DELETE).
    return reply(rpcError(null, -32000, "Method not allowed"), 405, { Allow: "POST, OPTIONS" });
  }

  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) return reply(rpcError(null, -32600, "Content-Length is required"), 411);
  if (length > MAX_BODY_BYTES) return reply(rpcError(null, -32600, "Request is too large"), 413);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return reply(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0 || payload.length > 50) return reply(rpcError(null, -32600, "Invalid batch"), 400);
    const responses = (await Promise.all(payload.map((m) => dispatch(m as RpcRequest)))).filter((r) => r !== undefined);
    return responses.length ? reply(responses) : new Response(null, { status: 202, headers: CORS });
  }
  const response = await dispatch(payload as RpcRequest);
  return response === undefined ? new Response(null, { status: 202, headers: CORS }) : reply(response);
}

export async function handleMcpRoutes(req: Request, url: URL, server: Bun.Server<unknown>): Promise<Response | null> {
  if (url.pathname === "/mcp") return handleMcp(req, url);
  return handleOAuthRoutes(req, url, server);
}
