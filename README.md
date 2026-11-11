# Storage App

A small self-hosted file storage app. Files live in an S3 bucket; the app gives you a
password-protected web UI to browse folders, upload, download, share and delete them.

- **Backend:** TypeScript on [Bun](https://bun.sh), using Bun's built-in HTTP server and S3 client (no runtime dependencies)
- **Storage:** AWS S3 or any S3-compatible service
- **Frontend:** plain HTML/CSS/JS, served by the backend (no build step)
- **Deploy:** Docker Compose on any VM or EC2 instance

## Features

- Folder browsing, new folders, drag-and-drop multi-file upload with progress
- Uploads and downloads are streamed through the server (multipart to S3), so large files do not need large memory
- Resumable/seekable downloads (HTTP range requests), in-browser preview for images, video, audio, PDF and text
- Time-limited share links (presigned S3 URLs, 1 hour to 7 days)
- Single-user login with a signed session cookie and failed-login throttling
- Optional [MCP connector](#mcp-connector) so AI clients (Claude, ChatGPT, Cursor, VS Code, ...) can work with your files

## Quick start (AWS S3)

You need Docker with the Compose plugin, an S3 bucket, and an access key that can use it.

```sh
git clone <this repo> && cd Storage-App
cp .env.example .env
# edit .env: APP_PASSWORD, SESSION_SECRET (openssl rand -hex 32), S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
docker compose up -d --build
```

Open `http://<server-ip>:3000` and sign in with `APP_USERNAME` / `APP_PASSWORD`.
On EC2, allow inbound TCP 3000 (or 80/443 if you use the HTTPS setup below) in the security group.

Minimal IAM policy for the access key:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::YOUR_BUCKET" },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
    }
  ]
}
```

The app needs explicit access keys; EC2 instance roles are not picked up automatically.

## No bucket? Run S3 storage on the same host

`docker-compose.local-s3.yml` adds [SeaweedFS](https://github.com/seaweedfs/seaweedfs) as an
S3-compatible store and creates the bucket for you. In `.env`, set `APP_PASSWORD`,
`SESSION_SECRET`, and pick any values for `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, then:

```sh
docker compose -f docker-compose.yml -f docker-compose.local-s3.yml up -d --build
```

- Files are stored in the `s3-data` Docker volume. That volume is the only copy, so back it up.
- For share links to work from other machines, set `S3_PUBLIC_ENDPOINT=http://<server-ip>:8333`
  in `.env` and allow inbound TCP 8333.

## HTTPS

Logging in over plain HTTP sends the password unencrypted, so use HTTPS for anything beyond a
trusted network. `docker-compose.https.yml` puts [Caddy](https://caddyserver.com) in front and
gets a Let's Encrypt certificate automatically. Point a DNS name at the server, open ports 80
and 443, set `DOMAIN=files.example.com` in `.env`, then:

```sh
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

This also turns on `COOKIE_SECURE` and stops publishing port 3000 directly. All three compose
files can be combined.

## MCP connector

The app can serve a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`
so AI clients can browse, read, write and share your files. It is off by default. Set
`MCP_ENABLED=true` in `.env` and run `docker compose up -d` again.

| Tool | What it does |
| --- | --- |
| `list_files`, `search_files`, `get_file_info` | Browse folders and find files by name |
| `read_file` | Read text files (in pieces for large ones) and small images |
| `create_share_link` | Make a temporary public download URL |
| `write_file`, `create_folder` | Create or replace files and folders |
| `delete_file`, `delete_folder` | Delete permanently |

Set `MCP_READ_ONLY=true` to leave out the last two rows.

### Connecting a client

The connector URL is your app address plus `/mcp`, for example `https://files.example.com/mcp`.

**Clients with sign-in (Claude, ChatGPT, Cursor, VS Code, Claude Code):** add the URL as a custom
connector / remote MCP server. The client opens a "Connect to Storage" page in your browser;
approve it with the app username and password. Nothing else needs configuring: the app is its own
OAuth server with dynamic client registration.

```sh
claude mcp add --transport http storage https://files.example.com/mcp   # Claude Code, then /mcp to sign in
```

**Clients without sign-in, scripts:** set `MCP_TOKEN` to a long random value
(`openssl rand -hex 32`) and send it as a bearer token.

```sh
claude mcp add --transport http storage https://files.example.com/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

```json
{ "mcpServers": { "storage": { "url": "https://files.example.com/mcp", "headers": { "Authorization": "Bearer <MCP_TOKEN>" } } } }
```

### Things to know

- Hosted clients such as Claude and ChatGPT connect from their own servers, so the app must be
  reachable from the internet over HTTPS (use the HTTPS setup above). Desktop and CLI clients can
  also use a plain `http://localhost:3000/mcp` address.
- Behind a reverse proxy other than the bundled Caddy setup, set `PUBLIC_URL` to the public
  address so the sign-in links point to the right place.
- A connected client stays connected for up to 30 days without activity. To disconnect every
  client at once, change `APP_PASSWORD` or `SESSION_SECRET`.
- An AI client with write access can delete files on your behalf. Use `MCP_READ_ONLY=true` if
  you only want it to look things up.
- The transport is stateless Streamable HTTP: `POST /mcp` with JSON responses, tools only.

## Configuration

All settings are environment variables; `.env.example` documents each one.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_USERNAME` / `APP_PASSWORD` | `admin` / required | Login (password at least 8 characters) |
| `SESSION_SECRET` | required | Signs session cookies (at least 32 characters). Changing it signs everyone out |
| `SESSION_TTL_HOURS` | `168` | How long a login lasts |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind your own reverse proxy so login throttling sees real client IPs |
| `MCP_ENABLED` / `MCP_READ_ONLY` | `false` / `false` | Serve the MCP connector at `/mcp`; optionally without write tools |
| `MCP_TOKEN` | none | Fixed bearer token for MCP clients without sign-in (at least 24 characters) |
| `PUBLIC_URL` | from request | Public address of the app, used in MCP sign-in links |
| `APP_PORT` / `APP_BIND` | `3000` / `0.0.0.0` | Host port and address |
| `MAX_UPLOAD_MB` | `5120` | Largest single upload |
| `S3_BUCKET`, `S3_REGION` | required, `us-east-1` | Bucket |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` | required, required, optional | Credentials |
| `S3_ENDPOINT` | AWS | Set for S3-compatible services |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | Endpoint used in share links |
| `S3_VIRTUAL_HOSTED_STYLE` | `false` | `bucket.endpoint` addressing instead of `endpoint/bucket` |
| `S3_PREFIX` | none | Keep all files under this key prefix |
| `S3_PRUNE_EMPTY_FOLDERS` | `false` | Hide emptied folders on filesystem-backed S3 servers |

## Operations

```sh
docker compose logs -f app        # logs; prints "S3 connection OK" at startup
docker compose up -d --build      # apply an update or a changed .env
docker compose down               # stop
```

The container runs as a non-root user with a read-only filesystem and exposes `GET /api/health`
for its health check.

## Development

```sh
bun install
bun test            # unit tests
bun run typecheck
bun run dev         # needs the same environment variables as .env.example
```

### API

All routes except `health`, `session`, `login` and `logout` require the session cookie.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness |
| `GET` | `/api/session` | Current login state |
| `POST` | `/api/login` | `{ username, password }` |
| `POST` | `/api/logout` | |
| `GET` | `/api/files?prefix=dir/` | List a folder |
| `PUT` | `/api/files?key=dir/name` | Upload; request body is the file |
| `DELETE` | `/api/files?key=…` | Delete a file, or a folder and its contents if the key ends in `/` |
| `GET` | `/api/download?key=…[&inline=1]` | Download (supports `Range`) |
| `POST` | `/api/folders` | `{ key: "dir/new/" }` |
| `POST` | `/api/share` | `{ key, expiresIn }` in seconds, returns a presigned URL |

## Notes and limits

- One shared login; there are no per-user accounts or quotas.
- No rename/move (S3 has no rename, and Bun's client has no server-side copy).
- Empty folders are kept by a hidden `.keep` object, so a file named `.keep` is not shown.
- Share links are plain S3 presigned URLs: they cannot be revoked before they expire, short of rotating the access key.
