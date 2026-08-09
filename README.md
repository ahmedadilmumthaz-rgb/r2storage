# Self-Hosted Cloudflare R2 Alternative

A standalone, self-hosted object storage service — a drop-in **Cloudflare R2 alternative** that runs on your own **VPS using only the VPS's local disk**. No AWS, no R2, no external cloud storage involved: every object blob and the metadata database live in a folder on your server.

Supports the S3-compatible API, custom domains served over HTTPS through **nginx** (using your existing **Cloudflare origin certificate**), Access Key / IAM management, presigned URLs, and a Cloudflare-inspired dark-mode control panel.

## 📚 Documentation

- **[Deployment Guide](DEPLOYMENT.md)** — VPS setup, DNS, Cloudflare, HTTPS/nginx + origin cert, backups, upgrades, hardening, troubleshooting.
- **[API Reference](API.md)** — full S3 + Admin API reference with usage samples for AWS CLI, Node.js, Python (boto3), Go, Rclone, Cyberduck, and presigned URLs.
- **[Using It in Other Projects](USAGE.md)** — framework recipes (Next.js, Django, Rails ActiveStorage, Laravel, direct browser uploads, backups) plus runnable examples in [`examples/`](examples/).
- **[SaaS Control Plane (`platform/`)](PLATFORM.md)** — the multi-tenant layer: signup/auto-provisioning, per-tenant Docker instances, usage metering, Cloudflare SSL-for-SaaS domains, and the operator console.

---

## ✨ Key Features

- **S3 Protocol Compatible**: `PutObject`, `GetObject`, `DeleteObject`, `ListObjectsV2`, `HeadObject`, and **Multipart Uploads** (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`). Works with the AWS CLI, Rclone, Cyberduck, `@aws-sdk/client-s3`, etc.
- **Local VPS Storage Only**: blobs are streamed to `STORAGE_DIR` on the VPS disk; metadata lives in SQLite next to it. No third-party storage services.
- **Real AWS SigV4 Authentication**: signatures are actually verified against the secret key (header + presigned URL), and `FULL` / `READ_ONLY` / `WRITE_ONLY` permissions plus per-key bucket filters are enforced.
- **Custom Domains & HTTPS**: map `cdn.yourdomain.com` to buckets and serve them over HTTPS through your existing **nginx** + **Cloudflare origin certificate** setup.
- **IAM & Access Key Security**: issue Access Key ID / Secret pairs with granular permissions and bucket scoping.
- **Presigned URLs**: HMAC-SHA256 signed temporary links for secure file downloads.
- **Secure Admin Panel**: the control panel is locked behind the `ADMIN_SECRET` login. Logging in swaps the secret for an **HttpOnly SameSite=Strict session cookie** (token stored hashed server-side, so sessions expire and are revocable) — the secret never lives in browser-accessible storage. Scripts/CLI can keep using the `X-Admin-Secret` header.
- **Web Control Panel**: dark-mode React dashboard with live analytics, object browser, drag-and-drop uploader, domain setup, and API key manager.

---

## 🚀 VPS Deployment

Runs natively on the VPS behind your existing **nginx** (Node.js + systemd) — no Docker. HTTPS uses your existing **Cloudflare origin certificate**.

```bash
# on the VPS
chmod +x deploy.sh
BASE_DOMAIN=ahmedadil.me ./deploy.sh
```

The script installs Node 20, builds the app, sets up a `r2storage` systemd service (bound to `127.0.0.1:4000`), generates a strong `ADMIN_SECRET` (printed once — save it!), and installs an nginx site for `cdn.` / `panel.` / `*.` subdomains.

> **Node.js 20+ required.** The backend runs on **Fastify 5** with the Fastify-5-line `@fastify/*` plugins; `npm audit` reports **0 vulnerabilities** only with this combination.

Dashboard: `https://panel.ahmedadil.me` · Object CDN: `https://cdn.ahmedadil.me/<key>`.

> **Everything is stored on the VPS itself** under `/var/lib/r2storage` (SQLite database + object blobs). Back this folder up with `rsync`/`borg`/restic to protect against disk failure — a single VPS disk has no built-in redundancy.

> Full prerequisites (Cloudflare origin cert, DNS records, firewall, backups) are in the **[Deployment Guide](DEPLOYMENT.md)**.

### Configuration (environment variables)

| Variable                | Default                              | Description                                             |
| ----------------------- | ------------------------------------ | ------------------------------------------------------- |
| `ADMIN_SECRET`          | *required*                           | Password that unlocks the admin control panel / API.    |
| `HOST`                  | `127.0.0.1`                          | Backend bind address (keep on loopback; nginx proxies). |
| `PORT`                  | `4000`                               | Backend HTTP port (loopback only).                      |
| `STORAGE_DIR`           | `/var/lib/r2storage/storage_blobs`   | Local VPS folder for object blobs.                      |
| `DATABASE_URL`          | `file:/var/lib/r2storage/storage.db` | SQLite database file.                                   |
| `BASE_DOMAIN`           | `ahmedadil.me`                       | Base domain for `<bucket>.yourdomain.com` style access. |
| `ADMIN_SESSION_TTL_HOURS` | `24`                               | How long a dashboard login stays valid (hours).        |
| `RATE_LIMIT_GLOBAL`     | `300`                                | Requests/min/IP baseline.                               |
| `RATE_LIMIT_ADMIN`      | `30`                                 | Requests/min/IP on `/api/admin/*` (brute-force guard).  |
| `RATE_LIMIT_S3`         | `600`                                | Requests/min/IP on `/s3/*`.                             |
| `LOG_RETENTION_DAYS`    | `30`                                 | How long S3 request logs are kept before pruning.       |

---

## 💻 Local Development

### 1. Start Backend API
```bash
cd backend
cp .env.example .env      # then set ADMIN_SECRET to something
npm install
npm run db:push
npm run dev
```

### 2. Start Frontend Control Panel
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` and log in with your `ADMIN_SECRET`.

---

## 🔑 AWS CLI Integration Example

```bash
# Configure credentials
aws configure set aws_access_key_id r2_YOUR_KEY_ID
aws configure set aws_secret_access_key YOUR_SECRET_KEY

# Upload object
aws s3 cp image.png s3://my-bucket/image.png --endpoint-url https://cdn.ahmedadil.me/s3

# List objects
aws s3 ls s3://my-bucket --endpoint-url https://cdn.ahmedadil.me/s3
```

### Multipart / large uploads

```bash
aws s3 cp large-file.bin s3://my-bucket/ --endpoint-url https://cdn.ahmedadil.me/s3
# aws cli automatically uses multipart uploads for large files
```

---

## 🌐 Custom Domains (e.g. `cdn.yourdomain.com`)

Serving objects on a custom domain takes three steps:

1. **DNS**: add an **A record** (`cdn.yourdomain.com` → your VPS IP). A CNAME record cannot point directly at an IP. If the parent domain is behind Cloudflare, keep the proxy (orange cloud) **ON**.

2. **Control panel**: open *Custom Domains* → *Add Custom Domain*, enter the domain, and pick the bucket. (The bucket must be set to **Public** for direct domain access.)

3. **nginx**: the domain must be proxied to the backend. The deploy script installs a site config for `cdn.` / `panel.` / `*.` subdomains that forwards the Host header; for an extra domain, add a `server_name` and reload:

   ```bash
   nginx -t && systemctl reload nginx
   ```

Once TLS (via your Cloudflare origin certificate) is active, `https://cdn.yourdomain.com/<key>` streams your objects directly.

### If your domain is proxied through Cloudflare

- Set Cloudflare **SSL/TLS mode → Full (strict)** — required with a Cloudflare origin certificate.
- Keep the DNS record **proxied**; Cloudflare handles edge TLS and routes to your origin over HTTPS.
- The nginx site uses a wildcard (`*.yourdomain.com`) for subdomain-style buckets. nginx always prefers a *specific* `server_name`, so your other apps' configs are unaffected.

---

## ⚠️ Security Notes

- Always set a strong `ADMIN_SECRET` before exposing the service publicly. The server logs a warning if you run with the default.
- The dashboard uses **session authentication**: `POST /api/admin/login` exchanges the secret for an `HttpOnly SameSite=Strict` cookie (SHA-256-hashed token in SQLite, `ADMIN_SESSION_TTL_HOURS` expiry, revocable via logout). The secret is never kept in `sessionStorage`/`localStorage`. Scripts may still authenticate with the `X-Admin-Secret` header — treat it as a credential.
- Access key signatures are verified server-side; a leaked Access Key ID alone is **not** sufficient to authenticate.
- Use a firewall (e.g. `ufw`) to keep the backend bound to loopback and serve the S3 API through nginx over HTTPS.
- Built-in hardening: per-IP rate limits (30/min admin, 600/min S3, 300/min baseline — all configurable; behind Cloudflare the IP is the `CF-Connecting-IP`, so every visitor gets their own budget), security headers via `@fastify/helmet`, CORS disabled globally (object endpoints still send `Access-Control-Allow-Origin`), SQLite in WAL mode with a busy timeout, graceful shutdown on `SIGTERM`, and automatic cleanup of stale temp files, abandoned multipart uploads, expired sessions, and request logs older than `LOG_RETENTION_DAYS`. See `DEPLOYMENT.md` § 9.
