import { S3Client } from "bun";
import { config } from "./config.ts";
import { baseName } from "./keys.ts";

const { s3 } = config;

const baseOptions = {
  bucket: s3.bucket,
  region: s3.region,
  accessKeyId: s3.accessKeyId,
  secretAccessKey: s3.secretAccessKey,
  sessionToken: s3.sessionToken,
  virtualHostedStyle: s3.virtualHostedStyle,
};

const client = new S3Client({ ...baseOptions, endpoint: s3.endpoint });
// Share links are opened by browsers, which may need a different hostname than the
// one this container uses to reach S3 (e.g. MinIO on the compose network).
const presignClient = new S3Client({ ...baseOptions, endpoint: s3.publicEndpoint ?? s3.endpoint });

/**
 * Bun's S3 client drops trailing slashes from keys, so an empty folder cannot be
 * represented by the usual zero-byte "name/" object. A hidden placeholder file inside
 * the folder does the same job on every S3 implementation.
 */
const FOLDER_PLACEHOLDER = ".keep";

const full = (key: string) => s3.prefix + key;
const strip = (key: string) => key.slice(s3.prefix.length);

export interface FileEntry {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
}

export interface FolderEntry {
  key: string;
  name: string;
}

export interface Listing {
  prefix: string;
  folders: FolderEntry[];
  files: FileEntry[];
}

export function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return code === "NoSuchKey" || code === "NotFound" || code === "ENOENT";
}

/** Lists the immediate children of a folder ("" for the root). */
export async function list(prefix: string): Promise<Listing> {
  const folders: FolderEntry[] = [];
  const files: FileEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.list({
      prefix: full(prefix),
      delimiter: "/",
      maxKeys: 1000,
      continuationToken,
    });
    const prefixes = (page.commonPrefixes ?? []).map((p) => p.prefix);
    const keep = s3.pruneEmptyFolders ? await Promise.all(prefixes.map(hasObjects)) : [];
    prefixes.forEach((p, i) => {
      if (s3.pruneEmptyFolders && !keep[i]) return;
      const key = strip(p);
      folders.push({ key, name: baseName(key) });
    });
    for (const obj of page.contents ?? []) {
      const key = strip(obj.key);
      if (key === prefix || key === prefix + FOLDER_PLACEHOLDER) continue;
      files.push({
        key,
        name: baseName(key),
        size: obj.size ?? 0,
        lastModified: obj.lastModified ? new Date(obj.lastModified).toISOString() : null,
      });
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  folders.sort(byName);
  files.sort(byName);
  return { prefix, folders, files };
}

/** Filesystem-backed S3 servers keep listing a directory after its last object is gone. */
async function hasObjects(fullPrefix: string): Promise<boolean> {
  const page = await client.list({ prefix: fullPrefix, maxKeys: 1 });
  return (page.contents?.length ?? 0) > 0;
}

export async function createFolder(folderKey: string): Promise<void> {
  await client.write(full(folderKey) + FOLDER_PLACEHOLDER, "");
}

export class UploadTooLargeError extends Error {}

/** Streams a request body into S3 using multipart upload, never buffering the whole file. */
export async function upload(
  key: string,
  body: ReadableStream<Uint8Array> | null,
  contentType: string,
  maxBytes: number,
): Promise<number> {
  const file = client.file(full(key));
  if (!body) {
    await file.write("", { type: contentType });
    return 0;
  }
  const writer = file.writer({ type: contentType, partSize: 8 * 1024 * 1024, queueSize: 4, retry: 3 });
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new UploadTooLargeError();
      await writer.write(chunk);
    }
    await writer.end();
  } catch (err) {
    // Finish the writer so no multipart upload is left dangling, then remove the partial object.
    await Promise.resolve(writer.end()).catch(() => {});
    await file.delete().catch(() => {});
    throw err;
  }
  return total;
}

export async function stat(key: string): Promise<{ size: number; type: string; lastModified: Date; etag: string }> {
  const s = await client.file(full(key)).stat();
  return { size: s.size, type: s.type, lastModified: s.lastModified, etag: s.etag };
}

/** Streams an object; `range` is an inclusive byte range. */
export function read(key: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const file = client.file(full(key));
  return (range ? file.slice(range.start, range.end + 1) : file).stream();
}

export async function removeFile(key: string): Promise<void> {
  await client.file(full(key)).delete();
}

/** Deletes every object under a folder. Returns the number of objects removed. */
export async function removeFolder(folderKey: string): Promise<number> {
  let removed = 0;
  let continuationToken: string | undefined;
  do {
    const page = await client.list({ prefix: full(folderKey), maxKeys: 1000, continuationToken });
    const keys = (page.contents ?? []).map((o) => o.key);
    for (let i = 0; i < keys.length; i += 20) {
      await Promise.all(keys.slice(i, i + 20).map((k) => client.file(k).delete()));
    }
    removed += keys.length;
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
  return removed;
}

/** A time-limited URL that downloads the file straight from S3, no login needed. */
export function shareUrl(key: string, expiresInSeconds: number): string {
  return presignClient.presign(full(key), { method: "GET", expiresIn: expiresInSeconds });
}

/** Cheap connectivity check used at startup. */
export async function ping(): Promise<void> {
  await client.list({ prefix: s3.prefix, maxKeys: 1 });
}
