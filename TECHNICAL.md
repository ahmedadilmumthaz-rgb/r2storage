# R2 Storage — Technical Overview

**Self-hosted S3/R2-compatible object storage with an optional multi-tenant SaaS control plane.**

Run your own object storage on a single VPS — no AWS, no Cloudflare R2, no third-party dependency. Every blob and metadata record lives on your disk. Speaks the real S3 API so existing tools (AWS CLI, boto3, Rclone, Cyberduck, any `@aws-sdk` client) work unmodified.

---

## Executive Summary

R2 Storage is a complete, production-grade object storage platform built for developers who want full control over their data without sacrificing API compatibility. It implements the core AWS S3 protocol — SigV4 authentication, multipart uploads, presigned URLs, byte-range serving, SSE-C encryption headers, aws-chunked streaming — and pairs it with a dark-mode admin dashboard, per-key IAM-style access controls, and an optional SaaS billing layer.

| | |
|---|---|
| **Protocol** | AWS S3 compatible (SigV4, presigned URLs, path-style + virtual-hosted) |
| **Storage** | Local VPS disk (SQLite metadata + SHA-256 addressed blobs) |
| **Encryption** | AES-256-GCM at rest (per-object random IV), SSE-C validate+echo |
| **Auth** | SigV4, presigned URLs, access key/secret pairs, session cookies |
| **Deployment** | One-command baremetal installer (systemd + nginx) or Docker SaaS mode |
| **Tests** | 347 automated checks (S3 protocol, auth, security, streaming, checksums) |

---

## Key Features

### S3 Protocol Fidelity

The backend implements the S3 wire protocol with enough fidelity to work with unmodified AWS tooling:

- **SigV4 authentication** — header-signed and presigned URL flows, with SDK path-style canonical URI acceptance (`/bucket/key` and `/s3/bucket/key` both verify)
- **aws-chunked streaming** — `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` chunks verified per-chunk against the top-level signature; `STREAMING-UNSIGNED-PAYLOAD` framed and stored; CRC-32 trailer checksums verified
- **Multipart uploads** — full lifecycle: `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListMultipartUploads`, `ListParts` with pagination
- **CopyObject** — server-side copy with `x-amz-metadata-directive` support; encrypted blobs copy byte-for-byte (no decrypt/re-encrypt roundtrip)
- **DeleteObjects** — batch delete via `POST ?delete` with quiet/non-quiet modes, capped at 1000 keys per request
- **Byte-range + conditional GET** — `Range` → `206`/`416`, `If-None-Match`/`If-Modified-Since` → `304`
- **Conditional writes** — `If-Match`/`If-Unmodified-Since` → `412`, `If-None-Match: *` → `409` (optimistic concurrency)
- **CRC-32 + Content-MD5** — integrity checks on upload and download
- **Bucket lifecycle** — prefix rules with `Days`/`Date` expiration, background sweeper
- **Bucket CORS** — configurable rules applied to every response + preflight `OPTIONS` for browser uploads
- **SSE-C** — `x-amz-server-side-encryption-customer-*` trio validated and echoed on all relevant operations (GET, PUT, HEAD, Copy, UploadPart, CreateMultipartUpload)

### IAM-Style Access Control

Every access key carries explicit permissions and optional scope:

| Permission | Capability |
|---|---|
| `FULL` | Read, write, delete |
| `READ_ONLY` | Get, Head, List |
| `WRITE_ONLY` | Put, UploadPart |

Keys can be scoped to specific buckets via `bucketFilter`, limiting the key's visibility to only that bucket's objects.

### Security Hardening

Security is treated as an invariant, not a feature checkbox:

| Layer | Implementation |
|---|---|
| **Secret comparison** | All credential checks use `crypto.timingSafeEqual` — no timing side-channels |
| **Admin sessions** | `HttpOnly; SameSite=Strict` cookies, server-side SHA-256 hashes, sliding renewal with absolute lifetime cap (7 days) |
| **Brute-force defense** | Escalating lockout: per-IP block (5 failures → 30 min cooldown) + global cooldown (15 failures → 5 min, doubling on re-trigger, capped at 1 hour), with `Retry-After` headers |
| **TOTP 2FA** | Optional RFC 6238 authenticator support (`ADMIN_TOTP_SECRET`); dashboard login requires 6-digit code when enabled; machine access via header exempt |
| **IP allowlist** | Optional `ADMIN_ALLOWED_CIDRS` gates the entire admin API including login |
| **Rate limiting** | Per-scope limits keyed off real client IP: admin 30/min, S3 600/min, global 300/min |
| **DoS hardening** | Bounded socket lifetimes (slowloris defense), streamed-to-disk bodies (never buffered in memory), 1MB cap on delete batch bodies |
| **No XXE surface** | XML parsed via regex only — no XML parser dependency |
| **Loopback binding** | Backend binds `127.0.0.1` by default; only reachable through nginx |
| **Audit trail** | Every privileged admin action recorded with auth source, IP, user agent; queryable at `GET /api/admin/audit` |
| **Failed login logging** | `FailedLogin` table with source IP, user agent, timestamp; surfaced in dashboard overview |

### Encryption at Rest

Optional AES-256-GCM encryption transparently protects every blob:

- **Per-object random IV** — each blob gets a unique initialization vector
- **Magic header detection** — `r2enc1` prefix identifies encrypted blobs for transparent decryption
- **Tamper detection** — GCM authentication tag rejects corrupted or modified ciphertext
- **Backward compatible** — plaintext blobs written before enabling encryption remain readable; no migration needed
- **Copy-safe** — encrypted blobs are self-contained; `copyFile` clones them byte-for-byte without decrypt/re-encrypt

When enabled, SSE-C headers (`x-amz-server-side-encryption-customer-*`) are validated and echoed to satisfy SDK expectations, but the customer key is never stored — the server-managed `STORAGE_ENCRYPTION_KEY` provides the real at-rest protection.

### Admin Dashboard

A dark-mode React control panel provides:

- **Bucket management** — create, configure public/private, manage custom domains
- **Access key issuance** — generate IAM-style key pairs with permission and bucket scope
- **Object browser** — upload, download, list, delete objects with public URL generation
- **Custom domain mapping** — map external domains to public buckets
- **Usage analytics** — storage bytes, request counts, bandwidth
- **Quota enforcement** — per-bucket storage limits with HTTP 507 on overflow
- **Audit log** — browse all privileged actions with auth source and IP
- **Session management** — login, logout, session expiry visibility

---

## Architecture

### Baremetal Mode (Recommended)

```
Cloudflare (proxied, SSL/TLS = Full strict)
   │
   ├─ cdn.<domain>       → nginx ──→ 127.0.0.1:4000
   ├─ panel.<domain>     → nginx ──→ 127.0.0.1:4000
   └─ <bucket>.<domain>  → nginx ──→ 127.0.0.1:4000
                                        │
                              ┌──────────┴──────────┐
                              │  Fastify backend     │
                              │  SigV4 + session     │
                              │  SQLite + blobs      │
                              └─────────────────────┘
```

- **Single binary** — compiled TypeScript runs as `node dist/index.js`
- **systemd managed** — auto-restart, sandboxing (NoNewPrivileges, PrivateTmp, ProtectHome, ProtectSystem=full)
- **nginx terminated TLS** — Cloudflare origin certificate, loopback-only backend
- **Per-instance isolation** — each instance gets its own service, port, data directory, and backup cron

### Containerized SaaS Mode (Optional)

```
┌─────────────────────────────────────────────┐
│  Next.js Control Plane                       │
│  Signup → Stripe → Provisioning → Metering   │
└──────────────────┬──────────────────────────┘
                   │ docker run per customer
    ┌──────────────┼──────────────┐
    │              │              │
  Tenant A      Tenant B      Tenant C
  (own DB)      (own DB)      (own DB)
  (own blobs)   (own blobs)   (own blobs)
  (own port)    (own port)    (own port)
```

- **Per-tenant Docker containers** — isolated SQLite + blob storage, resource caps (`--memory 1g --cpus 1`)
- **Host-header routing** — nginx maps incoming requests to the correct tenant container
- **Automated provisioning** — `docker run` → health check → default bucket/keys → nginx map write
- **Stripe billing** — subscription checkout, webhook sync, plan-based quotas
- **Operator console** — live per-tenant health, latency, quota, and usage visibility

---

## Installation

Two deployment options — pick the one that fits your infrastructure:

| | Baremetal VPS | Docker Container |
|---|---|---|
| **Best for** | Single-server, maximum control | Portable, reproducible, CI/CD |
| **Requires** | Linux VPS, nginx, Node.js | Docker installed |
| **Complexity** | One script handles everything | One `docker run` command |
| **TLS** | nginx + Cloudflare origin cert | Your reverse proxy (nginx/traefik/caddy) |
| **Data** | `/var/lib/<INSTANCE>/` on VPS disk | Docker volume at `/var/lib/r2storage` |
| **Upgrades** | Re-run `deploy.sh` | Rebuild image + recreate container |

---

### Option A: Baremetal VPS (Recommended)

Runs natively on a Linux VPS behind nginx — no Docker required. The installer handles Node.js, build, systemd, nginx, and health checks.

#### Prerequisites

| Requirement | Details |
|---|---|
| **OS** | Ubuntu 22.04/24.04, Debian 12, or similar |
| **Node.js** | Installed automatically if missing (Node 20 LTS) |
| **nginx** | Installed automatically if missing |
| **Domain** | DNS A records pointing to your VPS IP |
| **Cloudflare** | Free plan works — origin certificate + proxied DNS |

#### Step 1: Clone the repository

```bash
git clone https://github.com/ahmedadilmumthaz-rgb/r2storage.git
cd r2storage
chmod +x deploy.sh
```

#### Step 2: Run the installer

**Single shared instance** (one bucket per project, all behind `cdn.yourdomain.com`):

```bash
BASE_DOMAIN=yourdomain.com ./deploy.sh
```

**Per-project instances** (each gets its own domain, port, data, backups):

```bash
INSTANCE=project1 BASE_DOMAIN=project1.com PORT=4000 ./deploy.sh
INSTANCE=project2 BASE_DOMAIN=project2.com PORT=4001 ./deploy.sh
```

The script automatically:
1. Installs Node 20 LTS (if not present)
2. Installs dependencies and builds backend + frontend
3. Generates a strong `ADMIN_SECRET` (printed once — save it)
4. Creates a systemd service with sandboxing
5. Configures nginx reverse proxy
6. Runs a health check (waits up to 30 seconds)
7. Optionally installs backup cron (`--backups` flag)

On success, you'll see:

```
✅ Instance 'r2storage' deployed.
🌐 Dashboard: https://panel.yourdomain.com    CDN: https://cdn.yourdomain.com
💾 Data (backup this folder): /var/lib/r2storage
```

#### Step 3: Configure Cloudflare

1. **Origin certificate**: SSL/TLS → Origin Server → Create Certificate
   - Must cover `yourdomain.com` + `*.yourdomain.com`
   - Install at `/etc/ssl/cloudflare/yourdomain.com.{pem,key}`
2. **DNS A records** (proxied / orange cloud):
   ```
   cdn.yourdomain.com    A  <your-vps-ip>
   panel.yourdomain.com  A  <your-vps-ip>
   ```
3. **SSL/TLS mode**: Set to **Full (strict)**

#### Step 4: Verify

```bash
# Check service status
systemctl status r2storage

# Check logs
journalctl -u r2storage -f

# Test health endpoint
curl https://panel.yourdomain.com/health
```

Open `https://panel.yourdomain.com` and log in with your `ADMIN_SECRET`.

#### Configuration Reference

All configuration lives in `/etc/<instance>/env` (auto-generated, `chmod 600`):

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_SECRET` | auto-generated | Dashboard/API access credential |
| `HOST` | `127.0.0.1` | Bind address (loopback; nginx proxies) |
| `PORT` | `4000` | Backend HTTP port |
| `DATABASE_URL` | `file:/var/lib/<INSTANCE>/storage.db` | SQLite database path |
| `STORAGE_DIR` | `/var/lib/<INSTANCE>/storage_blobs` | Object blob storage location |
| `BASE_DOMAIN` | `localhost` | Domain for `cdn.`/`panel.` subdomains |
| `STORAGE_ENCRYPTION_KEY` | *empty* | AES-256-GCM at-rest encryption (64 hex chars). Generate: `openssl rand -hex 32` |
| `ADMIN_TOTP_SECRET` | *empty* | TOTP 2FA (base32 secret from authenticator app) |
| `ADMIN_ALLOWED_CIDRS` | *empty* | IP allowlist for admin API (comma-separated CIDRs) |
| `ADMIN_SESSION_TTL_HOURS` | `24` | Session idle timeout (sliding-renewed) |
| `ADMIN_SESSION_MAX_HOURS` | `168` | Session absolute lifetime cap (7 days) |
| `RATE_LIMIT_GLOBAL` | `300` | Per-IP global requests/min |
| `RATE_LIMIT_ADMIN` | `30` | Per-IP admin API requests/min |
| `RATE_LIMIT_S3` | `600` | Per-IP S3 API requests/min |
| `LOG_RETENTION_DAYS` | `30` | Request log retention before pruning |

To change a value after deployment:

```bash
sudo nano /etc/r2storage/env
sudo systemctl restart r2storage
```

#### Enabling Encryption at Rest

```bash
# Generate a key
ENCRYPTION_KEY=$(openssl rand -hex 32)

# Add to the env file
echo "STORAGE_ENCRYPTION_KEY=$ENCRYPTION_KEY" | sudo tee -a /etc/r2storage/env

# Restart
sudo systemctl restart r2storage
```

Existing plaintext blobs remain readable. New blobs are encrypted automatically.

#### Upgrading

Re-run the installer — it reuses your persisted `ADMIN_SECRET` and data directory:

```bash
cd r2storage
git pull
BASE_DOMAIN=yourdomain.com ./deploy.sh
```

#### Resource Requirements

| Workload | Minimum | Recommended |
|---|---|---|
| Single instance | 1 vCPU / 2 GB RAM / 40 GB disk | 2 vCPU / 4 GB RAM |
| 3-5 instances | 2 vCPU / 8 GB RAM | 4 vCPU / 16 GB RAM |

Idle memory per instance: ~150-300 MB. CPU is negligible at rest; scales with upload/download bandwidth.

---

### Option B: Docker Container

No code changes required — the Dockerfile and entrypoint are production-ready.

#### Prerequisites

| Requirement | Details |
|---|---|
| **Docker** | Docker Engine 20.10+ or Docker Desktop |
| **Disk** | Volume mount for persistent data |
| **Reverse proxy** | nginx, Traefik, Caddy, or similar (for TLS) |

#### Step 1: Build the image

```bash
git clone https://github.com/ahmedadilmumthaz-rgb/r2storage.git
cd r2storage

docker build -t r2storage -f backend/Dockerfile .
```

This runs a multi-stage build:
- **Build stage**: installs deps, compiles TypeScript, builds frontend
- **Runtime stage**: slim Node 20 image with only runtime dependencies, non-root user, healthcheck

#### Step 2: Run the container

```bash
# Generate a strong admin secret
ADMIN_SECRET=$(openssl rand -hex 32)
echo "Save this: $ADMIN_SECRET"

docker run -d \
  --name r2storage \
  --restart unless-stopped \
  --memory 1g \
  --cpus 1 \
  --pids-limit 256 \
  -p 127.0.0.1:4000:4000 \
  -v r2storage-data:/var/lib/r2storage \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=4000 \
  -e ADMIN_SECRET="$ADMIN_SECRET" \
  -e DATABASE_URL="file:/var/lib/r2storage/storage.db" \
  -e STORAGE_DIR="/var/lib/r2storage/storage_blobs" \
  -e BASE_DOMAIN=yourdomain.com \
  r2storage
```

#### Step 3: Configure TLS (reverse proxy)

The container binds to `127.0.0.1:4000` — not directly exposed. Use a reverse proxy for TLS termination.

**nginx example:**

```nginx
server {
    listen 443 ssl;
    server_name cdn.yourdomain.com panel.yourdomain.com *.yourdomain.com;

    ssl_certificate     /etc/ssl/cloudflare/yourdomain.com.pem;
    ssl_certificate_key /etc/ssl/cloudflare/yourdomain.com.key;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
    }
}
```

**docker-compose.yml example:**

```yaml
version: "3.8"
services:
  r2storage:
    build:
      context: .
      dockerfile: backend/Dockerfile
    container_name: r2storage
    restart: unless-stopped
    ports:
      - "127.0.0.1:4000:4000"
    volumes:
      - r2storage-data:/var/lib/r2storage
    environment:
      - NODE_ENV=production
      - HOST=0.0.0.0
      - PORT=4000
      - ADMIN_SECRET=${ADMIN_SECRET}
      - DATABASE_URL=file:/var/lib/r2storage/storage.db
      - STORAGE_DIR=/var/lib/r2storage/storage_blobs
      - BASE_DOMAIN=yourdomain.com
      # Optional: encryption at rest
      # - STORAGE_ENCRYPTION_KEY=your-64-char-hex-key
      # Optional: TOTP 2FA
      # - ADMIN_TOTP_SECRET=your-base32-secret
    deploy:
      resources:
        limits:
          memory: 1g
          cpus: "1"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:4000/health"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3

volumes:
  r2storage-data:
```

Run with:

```bash
ADMIN_SECRET=$(openssl rand -hex 32) docker compose up -d
```

#### Step 4: Verify

```bash
# Check container status
docker ps --filter name=r2storage

# Check logs
docker logs -f r2storage

# Test health endpoint
curl http://127.0.0.1:4000/health
# → {"status":"ok","service":"r2storage","timestamp":"..."}
```

#### Container Details

| Aspect | Value |
|---|---|
| **Base image** | `node:20-bookworm-slim` |
| **Runtime user** | `r2` (uid 10001, non-root) |
| **Data volume** | `/var/lib/r2storage` (SQLite + blobs) |
| **Entrypoint** | Runs `prisma db push` (auto-applies schema), then `node dist/index.js` |
| **Healthcheck** | `curl http://127.0.0.1:4000/health` every 30s |
| **Memory** | ~150-300 MB idle |
| **NODE_ENV** | `production` (required — server refuses default secret in production) |

#### Container Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ADMIN_SECRET` | **yes** | — | Dashboard/API access |
| `HOST` | no | `127.0.0.1` | Bind address (Dockerfile sets `0.0.0.0`) |
| `PORT` | no | `4000` | Backend port |
| `NODE_ENV` | no | `development` | Set to `production` for secure cookies |
| `DATABASE_URL` | no | `file:./dev.db` | SQLite path (set to volume path in production) |
| `STORAGE_DIR` | no | `./data_storage` | Blob path (set to volume path in production) |
| `BASE_DOMAIN` | no | `localhost` | Domain for subdomain routing |
| `STORAGE_ENCRYPTION_KEY` | no | *empty* | AES-256-GCM at-rest encryption |
| `ADMIN_TOTP_SECRET` | no | *empty* | TOTP 2FA |
| `ADMIN_ALLOWED_CIDRS` | no | *empty* | IP allowlist for admin API |

#### Upgrading the Container

```bash
# Rebuild the image
docker build -t r2storage -f backend/Dockerfile .

# Stop and remove the old container (data persists in the volume)
docker stop r2storage && docker rm r2storage

# Recreate with the same command (or docker compose up -d)
docker run -d --name r2storage ... r2storage
```

Or with docker-compose:

```bash
docker compose up -d --build
```

#### Backup

The Docker volume contains all data (SQLite database + object blobs). Back up the volume:

```bash
# Stop the container
docker stop r2storage

# Backup the volume
docker run --rm \
  -v r2storage-data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/r2storage-backup-$(date +%Y%m%d).tar.gz -C /data .

# Restart
docker start r2storage
```

---

### Post-Installation (Both Options)

After either installation method:

1. **Set up DNS**: `cdn.yourdomain.com` and `panel.yourdomain.com` → your server IP
2. **Configure TLS**: Cloudflare origin cert with SSL/TLS = Full (strict)
3. **Access dashboard**: `https://panel.yourdomain.com` — log in with `ADMIN_SECRET`
4. **Create an access key**: Dashboard → Access Keys → Issue New API Key
5. **Create a bucket**: Dashboard → Buckets → Create Bucket
6. **Start uploading**: Use AWS CLI, boto3, or any S3-compatible tool

#### Quick Test with AWS CLI

```bash
aws configure set aws_access_key_id r2_YOUR_ACCESS_KEY_ID
aws configure set aws_secret_access_key YOUR_SECRET_ACCESS_KEY

# Create a bucket
aws s3 mb s3://test-bucket --endpoint-url https://cdn.yourdomain.com/s3

# Upload a file
echo "Hello, R2 Storage!" > hello.txt
aws s3 cp hello.txt s3://test-bucket/hello.txt --endpoint-url https://cdn.yourdomain.com/s3

# List objects
aws s3 ls s3://test-bucket --endpoint-url https://cdn.yourdomain.com/s3

# Download
aws s3 cp s3://test-bucket/hello.txt ./downloaded.txt --endpoint-url https://cdn.yourdomain.com/s3
```

---

## SDK & Tool Compatibility

Tested and working with:

| Tool | Protocol | Notes |
|---|---|---|
| **AWS CLI** (`aws s3`) | SigV4 + aws-chunked | `--endpoint-url https://cdn.domain/s3` |
| **boto3** (Python) | SigV4 | `endpoint_url` parameter |
| **@aws-sdk/client-s3** (Node.js) | SigV4 | `endpoint` configuration |
| **Rclone** | S3 compatible | Native S3 backend |
| **Cyberduck** | S3 compatible | GUI client |
| **ActiveStorage** (Rails) | S3 compatible | `service: S3` configuration |
| **Laravel** (PHP) | S3 compatible | Flysystem S3 driver |
| **Presigned URLs** | Query-string auth | Generated via admin API or SDK presigners |

### Quick Start Examples

**AWS CLI:**
```bash
aws configure set aws_access_key_id r2_YOUR_KEY_ID
aws configure set aws_secret_access_key YOUR_SECRET_KEY

aws s3 mb s3://my-bucket --endpoint-url https://cdn.yourdomain.com/s3
aws s3 cp file.txt s3://my-bucket/file.txt --endpoint-url https://cdn.yourdomain.com/s3
aws s3 ls s3://my-bucket --endpoint-url https://cdn.yourdomain.com/s3
```

**Node.js (@aws-sdk/client-s3):**
```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "us-east-1",
  endpoint: "https://cdn.yourdomain.com/s3",
  credentials: {
    accessKeyId: "r2_YOUR_KEY_ID",
    secretAccessKey: "YOUR_SECRET_KEY",
  },
});

await s3.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "file.txt",
  Body: Buffer.from("Hello, R2 Storage!"),
}));
```

**Python (boto3):**
```python
import boto3

s3 = boto3.client('s3',
    endpoint_url='https://cdn.yourdomain.com/s3',
    aws_access_key_id='r2_YOUR_KEY_ID',
    aws_secret_access_key='YOUR_SECRET_KEY'
)

s3.upload_file('image.png', 'my-bucket', 'image.png')
```

---

## Testing & Quality

### Automated Test Suite

347 automated checks covering:

| Category | Checks | Coverage |
|---|---|---|
| S3 operations | PUT/GET/HEAD/DELETE, ListBuckets, ListObjectsV1+V2 | Core CRUD + listing |
| Multipart uploads | Create/Part/Copy/Complete/Abort, ListUploads, ListParts | Full lifecycle |
| CopyObject | Same-bucket, cross-bucket, metadata directive | Server-side copy |
| Batch delete | Quiet/non-quiet, missing keys, body cap | DeleteObjects |
| Object metadata | Content-Type, custom headers, tags | Metadata fidelity |
| SSE-C | Validate+echo, partial headers, missing key, CopyObject | Encryption headers |
| aws-chunked streaming | Signed chunks, unsigned chunks, CRC-32 trailers | Streaming uploads |
| Presigned URLs | Generation, expiry, SDK path-style SigV4 | URL auth |
| Byte-range + conditional | Range→206/416, If-None-Match→304, If-Modified-Since→304 | Range serving |
| Conditional writes | If-Match→412, If-None-Match:*→409 | Optimistic concurrency |
| CRC-32 checksums | Upload verification, download verification | Integrity |
| Bucket lifecycle | Prefix rules, Day/Date expiration, background sweep | Lifecycle mgmt |
| Bucket CORS | Rule matching, preflight OPTIONS, response headers | Browser uploads |
| Auth & sessions | Login, logout, session renewal, expiry, TOTP 2FA | Authentication |
| Rate limiting | Per-scope limits, lockout, global cooldown | Abuse prevention |
| Admin API | Overview, keys, quotas, audit, usage | Control plane |

### Running Tests

```bash
npm run build            # compile backend + frontend
npm test                 # 347-check smoke suite (boots throwaway instance)
bash scripts/sec-check.sh  # security spot-checks
npm run test:platform    # platform E2E (requires running platform)
```

---

## What This Is Not

R2 Storage is an engineering portfolio piece and a functional self-hosted tool — not a commercial cloud service:

- **Single-VPS durability** — no multi-region replication, no erasure coding. Back up `/var/lib/<INSTANCE>`.
- **SQLite metadata** — suitable for moderate workloads; not designed for millions of concurrent users.
- **No S3 API completeness** — missing features like bucket versioning, object ACLs, website hosting, object lock. The implemented surface covers what SDK tools and web apps actually use.

For production use, pair with a solid VPS provider and a backup strategy. For portfolio demonstration, it showcases protocol implementation, security hardening, multi-tenant architecture, and billing integration in a single codebase.

---

## Project Structure

```
backend/          Fastify S3/R2 backend + Prisma/SQLite
  src/index.ts      server bootstrap, security hardening
  src/config.ts     environment configuration
  src/api/s3.ts     S3 protocol implementation
  src/api/admin.ts  admin REST API
  src/api/auth.ts   session-based authentication
  src/auth/         SigV4 verification, constant-time secrets, TOTP 2FA
  src/storage/      hash-addressed blob engine, AES-256-GCM encryption
  src/api/aws-chunked.ts   aws-chunked streaming decoder
  src/api/ssec.ts   SSE-C validation + echo
frontend/         Vite + React control panel (dark mode)
platform/         Next.js SaaS control plane (signup, provisioning, Stripe)
deploy/           systemd + nginx templates, baremetal installer
scripts/          smoke.sh (347 checks), sec-check.sh, platform-smoke.sh
examples/         integration recipes (browser-upload, nextjs, laravel, rails)
```

---

## License

[MIT](LICENSE)
