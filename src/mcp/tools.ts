import { config } from "../config.ts";
import { KeyError, parseFileKey, parseFolderKey } from "../keys.ts";
import * as storage from "../storage.ts";

type Args = Record<string, unknown>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  write?: boolean;
  run(args: Args): Promise<ToolResult>;
}

class ToolError extends Error {}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const jsonText = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

const MAX_SHARE_SECONDS = 7 * 24 * 3600;
const MAX_READ_BYTES = 1_000_000;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function intArg(args: Args, name: string, fallback: number, min: number, max: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const PATH = { type: "string", description: 'File path inside the storage, e.g. "reports/2026/q1.pdf". No leading slash.' };
const FOLDER = { type: "string", description: 'Folder path, e.g. "reports/2026/". Empty string or omitted means the top level.' };

const tools: Tool[] = [
  {
    name: "list_files",
    title: "List files",
    description: "List the folders and files directly inside a folder of the storage.",
    inputSchema: object({ folder: FOLDER }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const prefix = parseFolderKey(args.folder ?? "", { allowRoot: true });
      const listing = await storage.list(prefix);
      return jsonText({
        folder: prefix,
        folders: listing.folders.map((f) => f.key),
        files: listing.files.map(({ key, size, lastModified }) => ({ path: key, size, lastModified })),
      });
    },
  },
  {
    name: "search_files",
    title: "Search files",
    description:
      "Find files whose path contains the query (case-insensitive), searching all subfolders. Matches names only, not file contents.",
    inputSchema: object(
      {
        query: { type: "string", description: "Text to look for in file paths." },
        folder: FOLDER,
        limit: { type: "integer", description: "Maximum results (default 50, max 200)." },
      },
      ["query"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      if (typeof args.query !== "string" || args.query.trim() === "") throw new ToolError("query is required");
      const prefix = parseFolderKey(args.folder ?? "", { allowRoot: true });
      const limit = intArg(args, "limit", 50, 1, 200);
      const result = await storage.search(prefix, args.query.trim(), limit, 20_000);
      return jsonText({
        files: result.matches.map(({ key, size, lastModified }) => ({ path: key, size, lastModified })),
        searchedEverything: result.complete,
        ...(result.complete ? {} : { note: `Stopped after ${result.scanned} files; narrow the folder or query to see more.` }),
      });
    },
  },
  {
    name: "get_file_info",
    title: "Get file info",
    description: "Get the size, content type and modification time of one file.",
    inputSchema: object({ path: PATH }, ["path"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const key = parseFileKey(args.path);
      const info = await storage.stat(key);
      return jsonText({ path: key, size: info.size, contentType: info.type, lastModified: info.lastModified.toISOString() });
    },
  },
  {
    name: "read_file",
    title: "Read file",
    description:
      "Read a file. Text files are returned as text, in pieces of up to max_bytes; small images are returned as images. " +
      "Other binary files cannot be read here: use create_share_link to get a download URL instead.",
    inputSchema: object(
      {
        path: PATH,
        offset: { type: "integer", description: "Byte offset to start from (default 0)." },
        max_bytes: { type: "integer", description: `Maximum bytes to return (default 100000, max ${MAX_READ_BYTES}).` },
      },
      ["path"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const key = parseFileKey(args.path);
      const offset = intArg(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const maxBytes = intArg(args, "max_bytes", 100_000, 1, MAX_READ_BYTES);
      const info = await storage.stat(key);
      if (info.size === 0) return text("(empty file)");
      if (offset >= info.size) throw new ToolError(`offset is past the end of the file (${info.size} bytes)`);

      const mime = info.type.split(";")[0]!.trim().toLowerCase();
      if (INLINE_IMAGE_TYPES.has(mime) && offset === 0 && info.size <= MAX_READ_BYTES) {
        const bytes = await storage.readBytes(key, { start: 0, end: info.size - 1 });
        return { content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime }] };
      }

      const end = Math.min(info.size, offset + maxBytes) - 1;
      const bytes = await storage.readBytes(key, { start: offset, end });
      if (bytes.includes(0)) {
        return text(
          `This is a binary file (${info.type || "unknown type"}, ${info.size} bytes) and cannot be shown as text. ` +
            "Use create_share_link to get a download URL.",
        );
      }
      let body = new TextDecoder("utf-8").decode(bytes);
      if (offset > 0 || end < info.size - 1) {
        body += `\n\n[Showing bytes ${offset}-${end} of ${info.size}.`;
        body += end < info.size - 1 ? ` Call read_file again with offset=${end + 1} for more.]` : "]";
      }
      return text(body);
    },
  },
  {
    name: "create_share_link",
    title: "Create share link",
    description:
      "Create a temporary public download URL for a file. Anyone with the URL can download the file until it expires, and it cannot be revoked early.",
    inputSchema: object(
      {
        path: PATH,
        expires_in_seconds: { type: "integer", description: "Lifetime of the link (default 3600, min 60, max 604800 = 7 days)." },
      },
      ["path"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const key = parseFileKey(args.path);
      const expiresIn = intArg(args, "expires_in_seconds", 3600, 60, MAX_SHARE_SECONDS);
      await storage.stat(key);
      return jsonText({ url: storage.shareUrl(key, expiresIn), expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() });
    },
  },
  {
    name: "write_file",
    title: "Write file",
    description:
      "Create a file, or replace one when overwrite is true. Use encoding \"base64\" for binary content. Missing folders are created automatically.",
    inputSchema: object(
      {
        path: PATH,
        content: { type: "string", description: "The file content." },
        encoding: { type: "string", enum: ["utf8", "base64"], description: 'How content is encoded (default "utf8").' },
        content_type: { type: "string", description: 'MIME type, e.g. "text/markdown". Guessed when omitted.' },
        overwrite: { type: "boolean", description: "Replace the file if it already exists (default false)." },
      },
      ["path", "content"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    write: true,
    async run(args) {
      const key = parseFileKey(args.path);
      if (typeof args.content !== "string") throw new ToolError("content must be a string");
      const encoding = args.encoding ?? "utf8";
      if (encoding !== "utf8" && encoding !== "base64") throw new ToolError('encoding must be "utf8" or "base64"');
      const data = encoding === "base64" ? new Uint8Array(Buffer.from(args.content, "base64")) : args.content;
      const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if (size > config.maxUploadBytes) throw new ToolError("File exceeds the upload size limit");
      if (args.overwrite !== true && (await storage.exists(key))) {
        throw new ToolError(`"${key}" already exists. Pass overwrite: true to replace it.`);
      }
      let type = typeof args.content_type === "string" && args.content_type ? args.content_type : Bun.file(key).type;
      if (!type || (type === "application/octet-stream" && encoding === "utf8")) type = "text/plain;charset=utf-8";
      await storage.writeData(key, data, type);
      return jsonText({ path: key, size });
    },
  },
  {
    name: "create_folder",
    title: "Create folder",
    description: "Create an empty folder.",
    inputSchema: object({ folder: { ...FOLDER, description: 'Folder path to create, e.g. "reports/2026/".' } }, ["folder"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    write: true,
    async run(args) {
      const key = parseFolderKey(args.folder);
      await storage.createFolder(key);
      return jsonText({ folder: key });
    },
  },
  {
    name: "delete_file",
    title: "Delete file",
    description: "Permanently delete one file. This cannot be undone.",
    inputSchema: object({ path: PATH }, ["path"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    write: true,
    async run(args) {
      const key = parseFileKey(args.path);
      await storage.stat(key); // report a missing file instead of silently succeeding
      await storage.removeFile(key);
      return jsonText({ deleted: key });
    },
  },
  {
    name: "delete_folder",
    title: "Delete folder",
    description: "Permanently delete a folder and everything inside it. This cannot be undone.",
    inputSchema: object({ folder: { ...FOLDER, description: 'Folder path to delete, e.g. "reports/2026/".' } }, ["folder"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    write: true,
    async run(args) {
      const key = parseFolderKey(args.folder);
      const removed = await storage.removeFolder(key);
      return jsonText({ deleted: key, filesRemoved: removed });
    },
  },
];

const available = tools.filter((tool) => !(tool.write && config.mcp.readOnly));

export function listTools() {
  return available.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations: { title, ...annotations },
  }));
}

/** Returns null when no such tool exists. Tool failures are reported in the result, not thrown. */
export async function callTool(name: unknown, args: unknown): Promise<ToolResult | null> {
  const tool = available.find((t) => t.name === name);
  if (!tool) return null;
  try {
    return await tool.run(args && typeof args === "object" ? (args as Args) : {});
  } catch (err) {
    let message: string;
    if (err instanceof ToolError || err instanceof KeyError) message = err.message;
    else if (storage.isNotFound(err)) message = "File not found";
    else {
      console.error(`[error] MCP tool ${tool.name}:`, err);
      message = "Storage backend error";
    }
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
