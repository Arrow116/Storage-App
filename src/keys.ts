/** Validation for object keys coming from the client. */

export class KeyError extends Error {}

const MAX_KEY_BYTES = 900; // S3 allows 1024; leave room for S3_PREFIX
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function checkSegments(key: string): void {
  if (CONTROL_CHARS.test(key)) throw new KeyError("Name contains control characters");
  if (key.includes("\\")) throw new KeyError("Backslashes are not allowed in names");
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new KeyError("Path is too long");
  for (const segment of key.split("/")) {
    if (segment === "") throw new KeyError("Path has an empty segment");
    if (segment === "." || segment === "..") throw new KeyError("Path may not contain . or ..");
  }
}

/** A file key: `a/b/c.txt`. No leading or trailing slash. */
export function parseFileKey(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") throw new KeyError("Missing file path");
  checkSegments(raw);
  return raw;
}

/** A folder key: `a/b/`. The empty string means the root. */
export function parseFolderKey(raw: unknown, opts: { allowRoot?: boolean } = {}): string {
  if (typeof raw !== "string") throw new KeyError("Missing folder path");
  if (raw === "") {
    if (opts.allowRoot) return "";
    throw new KeyError("Missing folder path");
  }
  const trimmed = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (trimmed === "") throw new KeyError("Invalid folder path");
  checkSegments(trimmed);
  return trimmed + "/";
}

export function baseName(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
