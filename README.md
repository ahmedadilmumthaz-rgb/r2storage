# R2 Storage Platform

Self-hosted, **S3/R2-compatible object storage** that runs on your own VPS disk — plus an optional **multi-tenant SaaS control plane** on top. No AWS, no R2, no third-party storage: every object blob and the metadata database live in a folder on your server.

It speaks the **real S3 API** (SigV4 auth, multipart uploads, presigned URLs — works with AWS CLI, Rclone, `@aws-sdk`, boto3, Cyberduck, ActiveStorage, ...) and ships with a dark-mode admin dashboard. The control plane layer turns the storage engine into a product: per-customer containers, signup → auto-provisioning, usage metering, plan quotas, Stripe billing, and an operator console.

> **Scope & realism.** This is an engineering project, not a commercial R2 competitor — a single-VPS install with per-tenant SQLite has no multi-region durability story, and it is not priced to undercut Cloudflare/Backblaze. It *is* a complete, working reference for: an S3 protocol implementation, a multi-tenant container platform, and a billing/metering control plane. Use it as a portfolio piece, or to run private, self-hosted object storage you fully control.

## 📚 Documentation

| Guide | Covers |
|---|---|
| **[Deployment Guide](DEPLOYMENT.md)** | Baremetal VPS setup: one instance per project or one shared instance, nginx + Cloudflare origin cert, backups, hardening, troubleshooting. |
| **[API Reference](API.md)** | Full S3 + Admin API reference with samples for AWS CLI, Node.js, Python (boto3), Go, Rclone, Cyberduck, presigned URLs. |
| **[Using It in Other Projects](USAGE.md)** | Framework recipes (Next.js, Django, Rails ActiveStorage, Laravel, direct browser uploads, backups) + runnable examples in [`examples/`](examples/). |
| **[SaaS Control Plane (`platform/`)](PLATFORM.md)** | The optional multi-tenant layer: signup/provisioning, per-tenant Docker instances, metering, quotas, Stripe, operator console. |

---

## 🏗️ Architecture

```
                    ┌────────────────────────────────────────────┐
                    │   CONTROL PLANE (optional, platform/)       │
                    │   Next.js · signup · Stripe · metering ·    │
                    │   quotas · operator console                 │
                    │   provisions & monitors per-tenant          │
                    │   containers via Docker + nginx host map    │
                    └───────────────┬────────────────────────────┘
                                    │
   ┌─────────────────────────────── ▼ ────────────────────────────┐
   │  TENANT LAYER — S3-compatible object storage backend         │
   │  Fastify · SigV4 auth · SQLite metadata · blobs on VPS disk  │
   └───────────────┬───────────────────────────────┬─────────────┘
                   │                               │
   ┌───────────────▼───────────┐     ┌─────────────▼──────────────┐
   │ nginx (baremetal mode)    │     │ per-tenant Docker          │
   │ cdn/panel/*.domain → :PORT│     │ containers (platform mode) │
   └───────────────────────────┘     └────────────────────────────┘
   TLS: your existing Cloudflare origin certificate (Full strict)
```

**Baremetal (primary):** one or more instances run natively — Node + systemd + nginx. Run one instance per project (own domain, port, data, backups) or one shared instance behind `cdn.yourdomain.com`.

**Containerized (optional):** the control plane runs each customer in its own Docker container with isolated DB/blobs, quotas, and metering — the "SaaS mode".

---

## ✨ What it demonstrates

| Engineering concern | Implementation |
|---|---|
| **Protocol fidelity** | Real AWS **SigV4** signature verification (header + presigned URLs), multipart uploads, `ListObjectsV2`, streaming GET/PUT. |
| **AuthN/AuthZ** | Access Key / Secret pairs with `FULL`/`READ_ONLY`/`WRITE_ONLY` permissions and per-key bucket filters; dashboard sessions via `HttpOnly SameSite=Strict` cookies (hashed server-side, revocable). |
| **Brute-force defense** | Escalating login lockout (per-IP block + doubling global cooldown with `Retry-After`), failed-login audit table, constant-time secret comparison, per-scope rate limits keyed off the real client IP. |
| **Multi-tenancy** | Per-tenant containers with own SQLite + blobs, resource caps (`--memory 1g --cpus 1`, read-only rootfs), loopback-only ports routed by Host header. |
| **Quota enforcement** | Storage quotas pushed at provision time and on plan changes; writes over the limit return HTTP **507** (also enforced on multipart `CompleteMultipartUpload`). |
| **Metering & billing** | Usage snapshots polled per tenant; optional Stripe subscription checkout/webhook sync that downgrades to Free on cancellation. |
| **Provisioning automation** | `docker run` → health wait → default bucket/keys → nginx map write + reload, with full rollback on failure. |
| **Operational visibility** | Operator console with live per-tenant health/latency and quota; request logging + admin analytics. |
| **Deploy automation** | One-command baremetal installer (per-instance systemd + nginx), Cloudflare-origin-cert TLS, per-instance backup cron. |
| **Testing** | Backend smoke suite (**50 checks** — S3, multipart, presigned, auth, rate limits) and a full-platform E2E smoke (`18 checks`), both runnable in CI. |

---

## 🚀 Baremetal deployment (recommended)

Runs natively on a VPS behind your existing **nginx** (Node.js + systemd) — no Docker. See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full runbook (Cloudflare origin cert, DNS, firewall, backups).

### One shared instance (all projects, one bucket each)

```bash
chmod +x deploy.sh
BASE_DOMAIN=ahmedadil.me ./deploy.sh     # serves cdn./panel./*.ahmedadil.me
```

### One instance per project (co-located on one VPS)

```bash
INSTANCE=project1 BASE_DOMAIN=project1.com PORT=4000 ./deploy.sh
INSTANCE=project2 BASE_DOMAIN=project2.com PORT=4001 ./deploy.sh
```

Each instance gets its own systemd service, loopback port, data dir, nginx site, and backup cron — fully isolated. The script installs Node 20, builds, generates a strong `ADMIN_SECRET` (printed once), and health-checks the instance before wiring nginx.

Dashboard: `https://panel.<domain>` · Object CDN: `https://cdn.<domain>/<key>`.

> **Everything is stored on the VPS** under `/var/lib/<INSTANCE>` (SQLite + blobs). Back this folder up — a single VPS disk has no built-in redundancy.

### Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `ADMIN_SECRET` | *required* | Unlocks the admin panel / API. |
| `HOST` | `127.0.0.1` | Bind address (loopback; nginx proxies). |
| `PORT` | `4000` | Backend HTTP port (loopback only). |
| `STORAGE_DIR` | `/var/lib/<INSTANCE>/storage_blobs` | Object blob location. |
| `DATABASE_URL` | `file:/var/lib/<INSTANCE>/storage.db` | SQLite database file. |
| `BASE_DOMAIN` | `ahmedadil.me` | Root domain for `cdn.` / `panel.` / `<bucket>.BASE_DOMAIN` access. |
| `ADMIN_SESSION_TTL_HOURS` | `24` | Dashboard login lifetime (hours). |
| `RATE_LIMIT_GLOBAL` / `RATE_LIMIT_ADMIN` / `RATE_LIMIT_S3` | `300` / `30` / `600` | Per-IP requests/min. |
| `LOG_RETENTION_DAYS` | `30` | Request-log retention before pruning. |

---

## 🚀 Containerized SaaS mode (optional)

The `platform/` directory is a complete multi-tenant control plane — signup, auto-provisioning, per-tenant Docker containers, quotas, usage metering, Stripe billing, and an operator console. Its own docs and VPS installer live in **[PLATFORM.md](PLATFORM.md)**.

```bash
# on the VPS
PLATFORM_DOMAIN=r2platform.com OPERATOR_EMAIL=ops@r2platform.com \
OPERATOR_PASSWORD='a-strong-password' sudo bash deploy/platform-deploy.sh
```

---

## 💻 Local development

### 1. Backend API
```bash
cd backend
cp .env.example .env      # then set ADMIN_SECRET to something
npm install
npm run db:push
npm run dev
```

### 2. Frontend control panel
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` and log in with your `ADMIN_SECRET`.

### Tests

```bash
npm run build             # build backend + frontend
npm test                  # backend smoke suite (50 checks, boots a throwaway instance)
bash scripts/sec-check.sh # ad-hoc security spot-checks (secret-less auth, presigned caps, login lockout)
npm run test:platform     # platform E2E smoke — needs a running platform (see PLATFORM.md)
```

---

## 🔑 AWS CLI integration example

```bash
aws configure set aws_access_key_id r2_YOUR_KEY_ID
aws configure set aws_secret_access_key YOUR_SECRET_KEY

aws s3 cp image.png s3://my-bucket/image.png --endpoint-url https://cdn.ahmedadil.me/s3
aws s3 ls s3://my-bucket --endpoint-url https://cdn.ahmedadil.me/s3
```

Large files are automatically multipart-uploaded by the CLI.

---

## 🌐 Custom domains

1. **DNS**: A record (`cdn.yourdomain.com` → your VPS IP). Proxied (orange cloud) if the zone is on Cloudflare.
2. **Control panel**: *Custom Domains* → *Add Custom Domain* → pick the bucket (must be **Public**).
3. **TLS**: served via your Cloudflare origin certificate with **SSL/TLS = Full (strict)**.

Once mapped: `https://cdn.yourdomain.com/<key>` streams objects directly. See `DEPLOYMENT.md` § 7.

---

## 🖼️ Screenshots

_→ TODO: capture the admin dashboard (Overview), the tenant S3 panel (Buckets/Keys/Domains), and the operator console (instance list with health/quota) and drop them here._

---

## ⚠️ Security notes

- Set a strong `ADMIN_SECRET`; the server warns if you run with a default. Log in exchanges it for an `HttpOnly SameSite=Strict` session cookie — the secret never reaches the browser.
- Access-key signatures are verified server-side; a leaked Access Key ID alone does **not** authenticate.
- Built-in hardening: per-IP rate limits keyed off `CF-Connecting-IP`, `@fastify/helmet` headers, CORS disabled globally (object endpoints still send `Access-Control-Allow-Origin`), SQLite WAL + busy timeout, graceful shutdown, orphan/temp cleanup. See `DEPLOYMENT.md` § 9.
- Keep the backend on loopback; serve it only through nginx over HTTPS.

---

## License

[MIT](LICENSE)
