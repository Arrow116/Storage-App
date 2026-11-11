function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

function bool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`${name} must be a positive number`);
    process.exit(1);
  }
  return parsed;
}

const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters (try: openssl rand -hex 32)");
  process.exit(1);
}

const password = required("APP_PASSWORD");
if (password.length < 8) {
  console.error("APP_PASSWORD must be at least 8 characters");
  process.exit(1);
}

let prefix = optional("S3_PREFIX") ?? "";
prefix = prefix.replace(/^\/+/, "");
if (prefix && !prefix.endsWith("/")) prefix += "/";

const mcpToken = optional("MCP_TOKEN");
if (mcpToken && mcpToken.length < 24) {
  console.error("MCP_TOKEN must be at least 24 characters (try: openssl rand -hex 32)");
  process.exit(1);
}

let publicUrl = optional("PUBLIC_URL");
if (publicUrl) {
  try {
    publicUrl = new URL(publicUrl).origin;
  } catch {
    console.error("PUBLIC_URL must be a full URL such as https://files.example.com");
    process.exit(1);
  }
}

export const config = {
  port: int("PORT", 3000),
  username: process.env.APP_USERNAME || "admin",
  password,
  sessionSecret,
  sessionTtlSeconds: int("SESSION_TTL_HOURS", 24 * 7) * 3600,
  cookieSecure: bool("COOKIE_SECURE"),
  trustProxy: bool("TRUST_PROXY"),
  /** Origin clients use to reach the app. Derived from the request when unset. */
  publicUrl,
  mcp: {
    enabled: bool("MCP_ENABLED"),
    readOnly: bool("MCP_READ_ONLY"),
    /** Optional static bearer token, for clients that cannot do the OAuth sign-in. */
    token: mcpToken,
  },
  maxUploadBytes: int("MAX_UPLOAD_MB", 5120) * 1024 * 1024,
  s3: {
    bucket: required("S3_BUCKET"),
    region: process.env.S3_REGION || "us-east-1",
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    sessionToken: optional("S3_SESSION_TOKEN"),
    endpoint: optional("S3_ENDPOINT"),
    /** Endpoint browsers can reach; used only to sign share links. */
    publicEndpoint: optional("S3_PUBLIC_ENDPOINT"),
    virtualHostedStyle: bool("S3_VIRTUAL_HOSTED_STYLE"),
    /** Hide folders that contain no objects. Costs one extra LIST per subfolder; not needed on AWS. */
    pruneEmptyFolders: bool("S3_PRUNE_EMPTY_FOLDERS"),
    prefix,
  },
} as const;
