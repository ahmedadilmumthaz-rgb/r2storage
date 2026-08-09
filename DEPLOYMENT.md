# Deployment Guide

Complete guide for putting R2 Storage Platform on a production VPS behind an existing **nginx** install, using a **Cloudflare origin certificate** for TLS — the same HTTPS setup your other apps already use.

---

## 1. What you need

| Requirement | Example | Why |
| --- | --- | --- |
| Linux VPS | Ubuntu 22.04/24.04, Debian 12 | Node + nginx host |
| Node.js 20 LTS | via NodeSource | Runtime for the backend, build tooling for the frontend |
| nginx | already installed | Reverse proxy + TLS termination (your existing setup) |
| A domain | `ahmedadil.me` | DNS + TLS + custom domain serving |
| Cloudflare | any free plan | DNS + proxy + the origin certificate you already use |

**Storage is entirely on the VPS disk.** Object blobs live in `STORAGE_DIR` and the SQLite metadata database next to it, both under `/var/lib/r2storage`. That folder is the *only* thing you need to back up.

---

## 2. Architecture

```
Cloudflare (proxied, SSL/TLS = Full strict)
   │
   ├─ https://cdn.ahmedadil.me     → nginx:443 ─┐
   ├─ https://panel.ahmedadil.me   → nginx:443 ─┼─→ 127.0.0.1:4000  (r2storage backend)
   └─ https://<bucket>.ahmedadil.me → nginx:443 ┘
```

- The backend binds **`127.0.0.1:4000`** only (not publicly reachable).
- nginx terminates TLS with your **Cloudflare origin certificate** and proxies to the backend.
- No Caddy, no Docker, no Let's Encrypt — this reuses exactly what your VPS already does for other apps.

---

## 3. One-time Cloudflare setup

1. **Origin certificate**: SSL/TLS → Origin Server → Create Certificate. Select the zone and make sure it covers **`ahmedadil.me` + `*.ahmedadil.me`** (one cert can cover the zone + subdomains), so `cdn.`, `panel.`, and future bucket subdomains all work without re-issuing.
2. **Install the cert on the VPS** (the files you already drop in for your other apps):
   ```bash
   mkdir -p /etc/ssl/cloudflare
   # paste certificate -> /etc/ssl/cloudflare/ahmedadil.me.pem
   # paste private key -> /etc/ssl/cloudflare/ahmedadil.me.key
   chmod 600 /etc/ssl/cloudflare/ahmedadil.me.key
   ```
   (If your existing origin cert is named differently, just edit the paths in `/etc/nginx/sites-available/r2storage`.)
3. **DNS records** (proxied / orange cloud):
   ```
   cdn.ahmedadil.me    A  203.0.113.10
   panel.ahmedadil.me  A  203.0.113.10
   ```
   A **CNAME cannot point at an IP** — use `A` records.
4. **SSL/TLS mode → Full (strict)** — works because the origin cert is Cloudflare-issued.

---

## 4. Deploy

### Option A — One-click script (recommended)

```bash
apt update && apt install -y curl openssl
git clone <your-repo-url> r2storage && cd r2storage
chmod +x deploy.sh
BASE_DOMAIN=ahmedadil.me ./deploy.sh
```

Optional flags (after a successful deploy):

```bash
./deploy.sh --smoke     # run the full smoke suite against a throwaway instance
./deploy.sh --backups   # install the daily backup cron (see § 10)
```

What it does:

1. Installs Node 20 (NodeSource) if missing.
2. Copies the app to `/opt/r2storage`, installs deps, builds backend + frontend, and copies the frontend build into `backend/dist/public`.
3. Creates the `r2storage` user and `/var/lib/r2storage`.
4. Writes `/etc/r2storage/env` with `HOST=127.0.0.1`, `PORT=4000`, `DATABASE_URL`, `STORAGE_DIR`, `BASE_DOMAIN`, and a generated `ADMIN_SECRET` (printed once, persisted for redeploys; `chmod 600`).
5. Installs `deploy/r2storage.service` (systemd) and starts it.
6. Installs the nginx site (`deploy/nginx-r2storage.conf`, with `__DOMAIN__` replaced by your `BASE_DOMAIN`), runs `nginx -t`, and reloads nginx.

### Option B — Manual

```bash
# 1. Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash && apt install -y nodejs

# 2. Build
cd /opt/r2storage/backend && npm install && npm run build
cd /opt/r2storage/frontend && npm install && npm run build
mkdir -p /opt/r2storage/backend/dist/public && cp -R /opt/r2storage/frontend/dist/. /opt/r2storage/backend/dist/public/

# 3. Data + user
useradd --system --home /opt/r2storage --shell /usr/sbin/nologin r2storage
mkdir -p /var/lib/r2storage/storage_blobs
chown -R r2storage:r2storage /opt/r2storage/backend /var/lib/r2storage

# 4. Env file (/etc/r2storage/env, chmod 600)
printf 'PORT=4000\nHOST=127.0.0.1\nDATABASE_URL=file:/var/lib/r2storage/storage.db\nSTORAGE_DIR=/var/lib/r2storage/storage_blobs\nADMIN_SECRET=%s\nBASE_DOMAIN=ahmedadil.me\n' "$(openssl rand -hex 32)" | tee /etc/r2storage/env && chmod 600 /etc/r2storage/env

# 5. systemd
cp deploy/r2storage.service /etc/systemd/system/r2storage.service
systemctl daemon-reload && systemctl enable --now r2storage

# 6. nginx
cp deploy/nginx-r2storage.conf /etc/nginx/sites-available/r2storage
sed -i 's/__DOMAIN__/ahmedadil.me/g' /etc/nginx/sites-available/r2storage
ln -s /etc/nginx/sites-available/r2storage /etc/nginx/sites-enabled/r2storage
nginx -t && systemctl reload nginx
```

---

## 5. Configuration

Environment file `/etc/r2storage/env`:

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_SECRET` | *required* | Unlocks the control panel and `/api/admin/*`. Long random value. |
| `BASE_DOMAIN` | `ahmedadil.me` | Base domain for `<bucket>.BASE_DOMAIN` public access and nginx `server_name`s. |
| `PORT` | `4000` | Backend port (loopback only — nginx proxies to it). |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback; never expose on the internet. |
| `DATABASE_URL` | `file:/var/lib/r2storage/storage.db` | SQLite database file. |
| `STORAGE_DIR` | `/var/lib/r2storage/storage_blobs` | Object blob location. |
| `ADMIN_SESSION_TTL_HOURS` | `24` | Dashboard login session lifetime (hours). |
| `RATE_LIMIT_GLOBAL` | `300` | Baseline requests/min/IP. |
| `RATE_LIMIT_ADMIN` | `30` | Requests/min/IP on `/api/admin/*` (brute-force guard). |
| `RATE_LIMIT_S3` | `600` | Requests/min/IP on `/s3/*`. |
| `LOG_RETENTION_DAYS` | `30` | S3 request-log rows kept before pruning. |

`/var/lib/r2storage` is your **backup unit** (SQLite + all object blobs).

---

## 6. Firewall & networking

```bash
ufw allow OpenSSH
ufw allow 80/tcp    # Cloudflare → origin (HTTP)
ufw allow 443/tcp   # Cloudflare → origin (HTTPS, your origin cert)
ufw enable
```

Port `4000` stays closed to the internet — nginx reaches it on the loopback interface. For extra hardening you can restrict `80`/`443` to Cloudflare's published IP ranges.

---

## 7. HTTPS & custom domains

The deployed nginx site (`/etc/nginx/sites-available/r2storage`) provides:

| Hostname | Purpose |
| --- | --- |
| `cdn.ahmedadil.me` | Object CDN: `https://cdn.ahmedadil.me/<key>` |
| `* .ahmedadil.me` | Subdomain-style buckets: `https://<bucket>.ahmedadil.me/<key>` |
| `panel.ahmedadil.me` | Admin control panel (dashboard + `/api/admin`) |

Both blocks proxy to `127.0.0.1:4000`, forward the original `Host` and `X-Forwarded-Proto`, and redirect `http` → `https`. The wildcard won't shadow your other apps — nginx always prefers a specific `server_name`.

The two forwarding headers are **required**:

- `Host $host` — the backend resolves `cdn.…/key` vs `<bucket>.…/key` from the Host header.
- `X-Forwarded-Proto` — used when the backend mints presigned URLs.

The shipped config also includes production streaming + hardening settings:

- `upstream r2storage_backend` with `keepalive 16` + `proxy_http_version 1.1` / `Connection ""` (HTTP keep-alive to the backend).
- `proxy_request_buffering off` + `proxy_buffering off` — objects stream straight through nginx to the client with no temp-file double-write.
- `proxy_next_upstream off` — a dropped upload is not silently replayed.
- Timeouts (`connect 10s`, `read/send 600s`) for slow/large transfers.
- `X-Forwarded-For` is rebuilt from `$http_cf_connecting_ip` — the **per-IP rate limit keys off the Cloudflare client IP**, so all your visitors (who share the same Cloudflare egress IPs) get their own budget instead of one shared bucket. For the rate limit to be meaningful, restrict `80`/`443` to Cloudflare's published IP ranges (see § 6) so clients can't spoof `CF-Connecting-IP` directly.
- CDN/virtual-host blocks run with `gzip off` (binary objects); the panel block gzips only text/JSON/JS/CSS/SVG.

### Mapping a domain to a bucket

1. Open the control panel at `https://panel.ahmedadil.me`, log in with `ADMIN_SECRET`.
2. **Buckets → create/edit a bucket → Public = on.**
3. **Custom Domains → Add Custom Domain** → enter the domain, pick the bucket.

Once mapped, objects are publicly streamable at:

```
https://cdn.ahmedadil.me/<key>
https://<bucket>.ahmedadil.me/<key>
```

Missing objects / private buckets return `404` / `403` (not the dashboard). Adding a *new* CDN subdomain later = add one `server_name` to the nginx site (or it's already covered by the wildcard) + a DNS record + a domain mapping; then `nginx -t && systemctl reload nginx`.

---

## 8. Access keys (IAM)

Create keys in the control panel (**Access Keys**) or via the admin API. Permissions:

| Permission | Can do |
| --- | --- |
| `FULL` | read, write, delete |
| `READ_ONLY` | list / GET / HEAD |
| `WRITE_ONLY` | PUT (no read, no delete) |

`bucketFilter` restricts a key to a single bucket. Full endpoint + SDK examples: `API.md`.

---

## 9. Built-in hardening

Applied automatically by the backend (no configuration needed). The backend runs **Fastify 5** and the `@fastify/*` plugin set pinned to their Fastify-5 lines (`cors` 10, `cookie` 11, `helmet` 12, `multipart` 9, `rate-limit` 11, `static` 10) — this combination is what `npm audit` reports **0 vulnerabilities** for.

- **Dashboard session authentication** — the panel no longer ships the shared secret to the browser. `POST /api/admin/login` exchanges `ADMIN_SECRET` for a random session token stored in an `HttpOnly SameSite=Strict` cookie (SHA-256-hashed in SQLite, `ADMIN_SESSION_TTL_HOURS` default 24h, revocable via logout / expiry sweep). `GET /api/admin/session` reports login state; the SPA locks on any 401. Scripts and CLI tools keep working via the `X-Admin-Secret` header, which the guard still accepts alongside a valid session cookie.
- **Rate limiting** — per IP: `300` req/min baseline, `30` req/min on `/api/admin/*` (blocks secret brute-force; failed logins count toward the limit and return `429`), `600` req/min on `/s3/*` — all configurable via `RATE_LIMIT_*`. Behind nginx the client IP is taken from `CF-Connecting-IP` (via the `trustProxy` + rebuilt `X-Forwarded-For` in § 7), so each visitor behind Cloudflare gets their own budget.
- **SQLite tuning** — WAL journal mode, `synchronous=NORMAL`, `busy_timeout=5000` applied at boot so concurrent multipart-part and admin writes don't hit `SQLITE_BUSY`.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` drains in-flight requests via `fastify.close()` before exiting (with a 15s force-exit safety net), so `systemctl restart` doesn't cut active transfers mid-stream.
- **Security headers** — CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, HSTS (`max-age=15552000; includeSubDomains`), referrer policy, and more via `@fastify/helmet`.
- **CORS disabled globally** — only object-serving endpoints (`/s3/...` GET/PUT and public CDN routes) send `Access-Control-Allow-Origin`, so CDN embedding keeps working while admin/S3 XML endpoints reject browser cross-origin reads.
- **Orphan cleanup** — on boot and hourly, the backend deletes `.tmp-*` files older than 1 hour, abandoned multipart uploads older than 24 hours (parts on disk + database rows), expired admin sessions, and request-log rows older than `LOG_RETENTION_DAYS`. Interrupted uploads also delete their own temp file immediately, so aborted transfers can't fill the disk.

---

## 10. Backups

Everything lives in `/var/lib/r2storage`:

```bash
# one-liner tar backup (database is SQLite — consistent enough for a hot backup)
tar czf r2storage-backup-$(date +%F).tar.gz /var/lib/r2storage

# or rsync to another machine
rsync -avz --delete /var/lib/r2storage/ backup-host:/backups/r2storage/
```

Schedule with cron (`crontab -e`):

```
0 3 * * * tar czf /backups/r2storage-$(date +%F).tar.gz /var/lib/r2storage && \
  find /backups -name 'r2storage-*' -mtime +14 -delete
```

Or install the bundled job (same thing, idempotent):

```bash
sudo bash deploy/backup-cron.sh /var/lib/r2storage   # or: ./deploy.sh --backups
```

> A single VPS disk has no redundancy. Restore = extract the archive to the same path, then `systemctl restart r2storage`.

---

## 11. Upgrading

```bash
cd /opt/r2storage
git pull
cd backend && npm install && npm run build
cd ../frontend && npm install && npm run build
mkdir -p ../backend/dist/public && cp -R dist/. ../backend/dist/public/
systemctl restart r2storage
```

The SQLite schema is applied automatically on service start (`ExecStartPre: npx prisma db push`). No code changes needed in nginx. Back up `/var/lib/r2storage` first.

---

## 12. Security hardening checklist

- [ ] `ADMIN_SECRET` is long and random (script generates 64 hex chars) and lives only in `/etc/r2storage/env` (root-only, `chmod 600`).
- [ ] Dashboard login uses the session cookie: `curl -I https://panel.…/api/admin/session` returns `{"authenticated":false}`, and `POST /api/admin/login` sets an `HttpOnly; SameSite=strict` cookie; the secret header still works for scripts.
- [ ] Backend binds `127.0.0.1:4000`; port `4000` is not open on the firewall.
- [ ] HTTPS works on all public hosts via the Cloudflare origin cert; Cloudflare SSL/TLS = **Full (strict)**.
- [ ] `80`/`443` are restricted to Cloudflare's IP ranges so `CF-Connecting-IP` (used for rate limiting) can't be spoofed.
- [ ] `systemd-analyze security r2storage` reports `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`, and friends are on (the shipped unit sets them; the backend's *only* write paths are `/opt/r2storage/backend` and `/var/lib/r2storage`).
- [ ] Access keys use least privilege (`READ_ONLY` for downloads, `WRITE_ONLY` for uploads) plus a `bucketFilter` where possible.
- [ ] Only buckets you actually want world-readable are set **Public**.
- [ ] `deploy.sh` is run from the repo root; `.env` / `/etc/r2storage/env` secrets are never committed.
- [ ] Backups run on a schedule and are stored off-box.
- [ ] Confirm rate limiting responds `429` after ~30 failed admin logins (`curl -I https://panel.…/api/admin/login`).
- [ ] Confirm `curl -I https://panel.…/api/admin/overview` shows `Strict-Transport-Security` / `X-Content-Type-Options` and **no** `Access-Control-Allow-Origin`.
- [ ] `npm test` (the smoke suite) passes from the repo root.

---

## 13. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `https://cdn.ahmedadil.me` never resolves / DNS not found | A record missing or not propagated — `dig +short cdn.ahmedadil.me`. |
| Cloudflare 522/525 | Origin (nginx) unreachable or TLS mismatch. Check `systemctl status nginx`, `journalctl -u nginx`; confirm the origin cert paths are right and SSL/TLS mode is **Full (strict)**. |
| `nginx -t` fails with "cannot load certificate" | Origin cert/key not at `/etc/ssl/cloudflare/ahmedadil.me.{pem,key}` — fix the paths in the site config or place the files. |
| `nginx -t` warns `"listen ... http2" directive is deprecated` | Harmless on nginx ≥1.25 — the shipped config's `listen ... ssl http2` syntax is for older distros (Ubuntu 22.04's 1.18) and still works. |
| Dashboard reachable but `https://cdn.…/<key>` returns the dashboard HTML | Domain not mapped in the control panel, or the bucket is private. Map it and set the bucket Public. |
| `InvalidAccessKeyId` / `SignatureDoesNotMatch` | Wrong endpoint path (must end in `/s3`), wrong region (use `us-east-1`), or wrong secret. See `API.md` § 1–3. |
| Large uploads fail with 413 | nginx `client_max_body_size` — the shipped config sets `0` (unlimited); if you trimmed it, restore it. |
| "Host header must be signed" | Custom client signs an `Authorization` header without `host` in `SignedHeaders`. AWS SDKs/CLI do this correctly. |
| Storage full / writes fail | VPS disk full — check `df -h`; run section 10 backups. |
| Dashboard logs me out during a session | Session expired (`ADMIN_SESSION_TTL_HOURS`, default 24h) or revoked server-side (restart/redeploy doesn't clear it — logout or expiry does). Log in again. |
| `Session cookie` isn't set on `POST /api/admin/login` | The cookie is only set on success, and only sent over HTTPS in production (`NODE_ENV=production`). Over plain HTTP the cookie is still usable in dev. |
| App won't start / logs empty | `journalctl -u r2storage -e`; confirm `/etc/r2storage/env` exists and is `chmod 600`, and `/var/lib/r2storage` is writable by `r2storage`. |

---

## 14. Local development

Backend (port `4000`):

```bash
cd backend
cp .env.example .env          # set ADMIN_SECRET to anything
npm install
npm run db:push
npm run dev
```

Frontend (port `5173`, proxies `/api` and `/s3` to the backend):

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` and log in with your `ADMIN_SECRET`.
