# Deployment Guide (baremetal)

Complete guide for running **R2 Storage instances natively on a Linux VPS** behind an existing **nginx** install, using a **Cloudflare origin certificate** for TLS — no Docker required.

## Two ways to run it

**A. One instance per project** — each project gets its own isolated instance (own service, port, data dir, backups, and domain). Several can share one VPS:

```bash
INSTANCE=project1 BASE_DOMAIN=project1.com   PORT=4000 ./deploy.sh
INSTANCE=project2 BASE_DOMAIN=project2.com   PORT=4001 ./deploy.sh
```

**B. One shared instance for all projects** — a single instance behind `cdn.yourdomain.com`, with one bucket per project:

```bash
BASE_DOMAIN=yourdomain.com ./deploy.sh       # serves cdn./panel./*.yourdomain.com
```

Pick A when a project needs its own domain, its own admin, or independent upgrades/backups. Pick B for the cheapest single-box option. You can mix both on the same VPS.

> **Why per-project instances use their own domain:** a Cloudflare origin certificate covers the **apex + exactly one wildcard level** (`yourdomain.com` + `*.yourdomain.com`). So `cdn.project1.com` works, but `cdn.project1.example.com` is *not* covered by a cert for `example.com` + `*.example.com`. Give each project instance its own root domain and the shared wildcard keeps working. The single shared instance (pattern B) needs just the one zone cert.

---

## 1. What you need

| Requirement | Example | Why |
| --- | --- | --- |
| Linux VPS | Ubuntu 22.04/24.04, Debian 12 | Node + nginx host |
| Node.js 20 LTS | via NodeSource | Runtime for the backend, build tooling for the frontend |
| nginx | already installed | Reverse proxy + TLS termination (your existing setup) |
| A domain | `ahmedadil.me` (or one per project) | DNS + TLS + custom domain serving |
| Cloudflare | any free plan | DNS + proxy + the origin certificate you already use |

**Storage is entirely on the VPS disk.** Object blobs live in the instance's `STORAGE_DIR` and the SQLite metadata database next to it, both under the instance data dir (default `/var/lib/<INSTANCE>`). That folder is the *only* thing you need to back up — per instance.

### Sizing / co-location

- A single instance idles at a few hundred MB of RAM and near-zero CPU — a **1 vCPU / 2 GB / 40 GB** slice easily runs one instance (pattern B, or pattern A for one project).
- Each additional instance adds ~150–300 MB RAM idle plus **its own stored-bytes disk and transfer**. Rough guide: a 2 vCPU / 8 GB box comfortably runs 3–5 project instances; go up when disk (stored data) or bandwidth becomes the constraint.
- Ports: first instance uses `4000`, the next `4001`, etc. All bind to `127.0.0.1` only.

---

## 2. Architecture

```
Cloudflare (proxied, SSL/TLS = Full strict)
   │
   ├─ https://cdn.project1.com       → nginx:443 ─┐
   ├─ https://panel.project1.com     → nginx:443 ─┼─→ 127.0.0.1:4000  (instance "project1")
   └─ https://<bucket>.project1.com  → nginx:443 ┘
   │
   ├─ https://cdn.project2.com       → nginx:443 ─┐
   └─ https://panel.project2.com     → nginx:443 ─┼─→ 127.0.0.1:4001  (instance "project2")
                                                   ┘
```

- Each instance binds **`127.0.0.1:<PORT>`** only (never publicly reachable).
- nginx terminates TLS with your **Cloudflare origin certificate** and proxies by Host header to the right loopback port.
- Every instance is its own systemd service, env file, data dir, and nginx site config — fully independent.

---

## 3. One-time Cloudflare setup

1. **Origin certificate**: SSL/TLS → Origin Server → Create Certificate. Select the zone and make sure it covers **`<domain>` + `*.<domain>`** (one cert covers the zone + one subdomain level), so `cdn.`, `panel.`, and future bucket subdomains all work without re-issuing. Create one per project domain if you run pattern A.
2. **Install the cert on the VPS**:
   ```bash
   mkdir -p /etc/ssl/cloudflare
   # paste certificate -> /etc/ssl/cloudflare/<domain>.pem
   # paste private key -> /etc/ssl/cloudflare/<domain>.key
   chmod 600 /etc/ssl/cloudflare/<domain>.key
   ```
   (If your origin cert is named differently, edit the paths in the instance's nginx site config.)
3. **DNS records** (proxied / orange cloud):
   ```
   cdn.<domain>    A  203.0.113.10
   panel.<domain>  A  203.0.113.10
   ```
   A **CNAME cannot point at an IP** — use `A` records.
4. **SSL/TLS mode → Full (strict)** — works because the origin cert is Cloudflare-issued.

---

## 4. Deploy

### Option A — One-click script (recommended)

```bash
apt update && apt install -y curl openssl rsync
git clone <your-repo-url> r2storage && cd r2storage
chmod +x deploy.sh
BASE_DOMAIN=ahmedadil.me ./deploy.sh          # one shared instance (pattern B)
```

Or per-project instances on the same box (pattern A):

```bash
INSTANCE=project1 BASE_DOMAIN=project1.com PORT=4000 ./deploy.sh
INSTANCE=project2 BASE_DOMAIN=project2.com PORT=4001 ./deploy.sh
```

Optional flags (after a successful deploy):

```bash
./deploy.sh --smoke     # run the full smoke suite against a throwaway instance
./deploy.sh --backups   # install the daily backup cron for this instance
```

What it does (per instance):

1. Installs Node 20 (NodeSource) if missing.
2. Copies the app to `/opt/<INSTANCE>`, installs deps, builds backend + frontend, and copies the frontend build into `backend/dist/public`.
3. Creates the `<INSTANCE>` user and `/var/lib/<INSTANCE>`.
4. Writes `/etc/<INSTANCE>/env` with `HOST=127.0.0.1`, `PORT=<PORT>`, `DATABASE_URL`, `STORAGE_DIR`, `BASE_DOMAIN`, and a generated `ADMIN_SECRET` (printed once, persisted for redeploys; `chmod 600`).
5. Renders `deploy/r2storage.service` → `/etc/systemd/system/<INSTANCE>.service` and starts it.
6. Waits for `http://127.0.0.1:<PORT>/health`.
7. Renders `deploy/nginx-r2storage.conf` (substituting `__DOMAIN__` and `__PORT__`) → `/etc/nginx/sites-available/<INSTANCE>`, runs `nginx -t`, and reloads nginx.
8. With `--backups`: installs a per-instance cron (`deploy/backup-cron.sh`).

Re-running the same `INSTANCE` upgrades in place and keeps the same `ADMIN_SECRET`, port, and data.

### Option B — Manual

```bash
# 1. Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash && apt install -y nodejs

# 2. Build (once per instance)
INSTANCE=project1
cd /opt/$INSTANCE/backend && npm install && npm run build
cd /opt/$INSTANCE/frontend && npm install && npm run build
mkdir -p /opt/$INSTANCE/backend/dist/public && cp -R /opt/$INSTANCE/frontend/dist/. /opt/$INSTANCE/backend/dist/public/

# 3. Data + user
useradd --system --home /opt/$INSTANCE --shell /usr/sbin/nologin $INSTANCE
mkdir -p /var/lib/$INSTANCE/storage_blobs
chown -R $INSTANCE:$INSTANCE /opt/$INSTANCE/backend /var/lib/$INSTANCE

# 4. Env file (/etc/$INSTANCE/env, chmod 600)
printf 'PORT=4000\nHOST=127.0.0.1\nDATABASE_URL=file:/var/lib/%s/storage.db\nSTORAGE_DIR=/var/lib/%s/storage_blobs\nADMIN_SECRET=%s\nBASE_DOMAIN=project1.com\n' \
  "$INSTANCE" "$INSTANCE" "$(openssl rand -hex 32)" | tee /etc/$INSTANCE/env && chmod 600 /etc/$INSTANCE/env

# 5. systemd (render the template)
sed -e "s/__INSTANCE__/$INSTANCE/g" -e "s/__USER__/$INSTANCE/g" \
    -e "s/__DIR__/\/opt\/$INSTANCE/g" -e "s/__ENV__/\/etc\/$INSTANCE\/env/g" \
    -e "s/__DATA__/\/var\/lib\/$INSTANCE/g" deploy/r2storage.service \
    > /etc/systemd/system/$INSTANCE.service
systemctl daemon-reload && systemctl enable --now $INSTANCE

# 6. nginx (render the site, substitute the domain + port)
cp deploy/nginx-r2storage.conf /etc/nginx/sites-available/$INSTANCE
sed -i 's/__DOMAIN__/project1.com/g; s/__PORT__/4000/g' /etc/nginx/sites-available/$INSTANCE
ln -s /etc/nginx/sites-available/$INSTANCE /etc/nginx/sites-enabled/$INSTANCE
nginx -t && systemctl reload nginx
```

---

## 5. Configuration

Per-instance env file `/etc/<INSTANCE>/env`:

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_SECRET` | *required* | Unlocks the control panel and `/api/admin/*`. Long random value, generated on first deploy. |
| `BASE_DOMAIN` | `ahmedadil.me` | Root domain for `cdn.` / `panel.` / `<bucket>.BASE_DOMAIN` access. |
| `PORT` | `4000` | Backend port (loopback only — nginx proxies to it). |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback; never expose on the internet. |
| `DATABASE_URL` | `file:/var/lib/<INSTANCE>/storage.db` | SQLite database file. |
| `STORAGE_DIR` | `/var/lib/<INSTANCE>/storage_blobs` | Object blob location. |
| `ADMIN_SESSION_TTL_HOURS` | `24` | Dashboard login session lifetime (hours). |
| `RATE_LIMIT_GLOBAL` | `300` | Baseline requests/min/IP. |
| `RATE_LIMIT_ADMIN` | `30` | Requests/min/IP on `/api/admin/*` (brute-force guard). |
| `RATE_LIMIT_S3` | `600` | Requests/min/IP on `/s3/*`. |
| `LOG_RETENTION_DAYS` | `30` | S3 request-log rows kept before pruning. |

`/var/lib/<INSTANCE>` is your **backup unit** (SQLite + all object blobs).

---

## 6. Firewall & networking

```bash
ufw allow OpenSSH
ufw allow 80/tcp    # Cloudflare → origin (HTTP)
ufw allow 443/tcp   # Cloudflare → origin (HTTPS, your origin cert)
ufw enable
```

Instance ports (`4000`, `4001`, …) stay closed to the internet — nginx reaches them on the loopback interface. For extra hardening you can restrict `80`/`443` to Cloudflare's published IP ranges.

---

## 7. HTTPS & custom domains

Each instance's nginx site (`/etc/nginx/sites-available/<INSTANCE>`) provides:

| Hostname | Purpose |
| --- | --- |
| `cdn.<BASE_DOMAIN>` | Object CDN: `https://cdn.<domain>/<key>` |
| `* .<BASE_DOMAIN>` | Subdomain-style buckets: `https://<bucket>.<domain>/<key>` |
| `panel.<BASE_DOMAIN>` | Admin control panel (dashboard + `/api/admin`) |

All three blocks proxy to `127.0.0.1:<PORT>` (the upstream is keyed by port — `r2storage_backend_<PORT>` — so multiple instance configs coexist without nginx upstream-name collisions), forward the original `Host` and `X-Forwarded-Proto`, and redirect `http` → `https`. The wildcard won't shadow your other apps — nginx always prefers a specific `server_name`.

The two forwarding headers are **required**:

- `Host $host` — the backend resolves `cdn.…/key` vs `<bucket>.…/key` from the Host header.
- `X-Forwarded-Proto` — used when the backend mints presigned URLs.

The shipped config also includes production streaming + hardening settings:

- `upstream r2storage_backend_<PORT>` with `keepalive 16` + `proxy_http_version 1.1` / `Connection ""` (HTTP keep-alive to the backend).
- `proxy_request_buffering off` + `proxy_buffering off` — objects stream straight through nginx to the client with no temp-file double-write.
- `proxy_next_upstream off` — a dropped upload is not silently replayed.
- Timeouts (`connect 10s`, `read/send 600s`) for slow/large transfers.
- `X-Forwarded-For` is rebuilt from `$http_cf_connecting_ip` — the **per-IP rate limit keys off the Cloudflare client IP**, so all your visitors (who share the same Cloudflare egress IPs) get their own budget instead of one shared bucket. For the rate limit to be meaningful, restrict `80`/`443` to Cloudflare's published IP ranges (see § 6) so clients can't spoof `CF-Connecting-IP` directly.
- CDN/virtual-host blocks run with `gzip off` (binary objects); the panel block gzips only text/JSON/JS/CSS/SVG.

### Mapping a domain to a bucket

1. Open the control panel at `https://panel.<domain>`, log in with the instance's `ADMIN_SECRET`.
2. **Buckets → create/edit a bucket → Public = on.**
3. **Custom Domains → Add Custom Domain** → enter the domain, pick the bucket.

Once mapped, objects are publicly streamable at:

```
https://cdn.<domain>/<key>
https://<bucket>.<domain>/<key>
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

- **Dashboard session authentication** — the panel no longer ships the shared secret to the browser. `POST /api/admin/login` exchanges `ADMIN_SECRET` for a random session token stored in an `HttpOnly SameSite=Strict` cookie (SHA-256-hashed in SQLite). Sessions **slide-renew** on activity (idle timeout `ADMIN_SESSION_TTL_HOURS`, default 24h) but are hard-capped by `ADMIN_SESSION_MAX_HOURS` (default 7 days), revocable via logout / expiry sweep. `GET /api/admin/session` reports login state and `expiresAt`; the SPA locks on any 401. Scripts and CLI tools keep working via the `X-Admin-Secret` header, which the guard still accepts alongside a valid session cookie.
- **Admin IP allowlist** — optional `ADMIN_ALLOWED_CIDRS` (comma-separated IPv4/IPv6 CIDRs) restricts the whole admin API — login included — to specific networks; everything else gets `403` before any auth logic. Evaluated against the real client IP (`CF-Connecting-IP` behind nginx). Leave empty for allow-all. Pairs naturally with a Cloudflare firewall/WAF rule scoping the panel's hostname.
- **Rate limiting** — per IP: `300` req/min baseline, `30` req/min on `/api/admin/*` (blocks secret brute-force; failed logins count toward the limit and return `429`), `600` req/min on `/s3/*` — all configurable via `RATE_LIMIT_*`. Behind nginx the client IP is taken from `CF-Connecting-IP` (via the `trustProxy` + rebuilt `X-Forwarded-For` in § 7), so each visitor behind Cloudflare gets their own budget. `/api/admin/login` itself gets a tighter `10` req/min cap.
- **Slowloris / body hardening** — socket lifetimes are bounded server-side (`SERVER_CONNECTION_TIMEOUT_MS` 30s idle, `SERVER_HEADERS_TIMEOUT_MS` 30s, `SERVER_REQUEST_TIMEOUT_MS` 10 min, max 1000 requests/socket) so a trickling client can't hold connections hostage; raise `SERVER_REQUEST_TIMEOUT_MS` for very slow large uploads. S3 bodies are streamed to disk (never buffered), multipart parts count toward the storage quota at `UploadPart` time (no unbounded part disk-fill), and the `CompleteMultipartUpload` part-list body is capped at 1MB. Request XML is parsed with regex + escaped string templates only — no XML parser is used, so there is no XXE surface.
- **Login lockout** — on top of rate limiting, failed logins trip an escalating lockout: per-IP block (`LOGIN_IP_COOLDOWN_SEC`, default 30 min) after `LOGIN_FAIL_THRESHOLD` (default 5) consecutive failures from one address, plus a global cooldown that doubles per re-trigger (cap 1h) once `LOGIN_GLOBAL_THRESHOLD` (default 15) failures accumulate across all IPs. Locked logins get `429` + `Retry-After`. Failures are also written to a `FailedLogin` audit table (surfaced as `failedLogins24h` in `/api/admin/overview`) and swept per `LOG_RETENTION_DAYS`. Wrong `X-Admin-Secret` header calls count per-IP only, so a misconfigured monitoring script can't trip the global tier.
- **TOTP 2FA** — optional `ADMIN_TOTP_SECRET` (base32 RFC 6238 secret, exactly what Google Authenticator / 1Password / Aegis provision): when set, the dashboard login requires a valid 6-digit authenticator code *on top of* `ADMIN_SECRET`. A missing or wrong code fails identically to a wrong secret — same lockout counting, same fixed-response delay, same `FailedLogin` row — so attackers can't tell which factor they missed. Machine access via the `x-admin-secret` header is exempt (it already carries a long random secret). Implemented with Node's built-in crypto (`auth/totp.ts`), verified against the RFC 6238 test vectors.
- **Admin audit trail** — every privileged admin action (bucket/key/domain/quota changes) is recorded in an `AuditLog` table with the auth source (`session` = dashboard cookie, `header` = x-admin-secret script), IP, and user agent, alongside `login.success`/`logout` events. It's viewable in the dashboard and queryable at `GET /api/admin/audit`, and is pruned alongside the other logs per `LOG_RETENTION_DAYS`. This complements request logging: the S3 request log shows *what* traffic happened, the audit trail shows *who changed the control plane*.
- **Encryption at rest** — optional `STORAGE_ENCRYPTION_KEY` (64 hex chars, `openssl rand -hex 32`): when set, every new blob is **AES-256-GCM** encrypted on disk with a per-object random IV (`r2enc1` magic + IV header), and multipart parts are encrypted too (decrypted + re-encrypted during assembly). Reads detect the magic and fall back to plaintext, so blobs written before you enabled a key stay readable. Keep the key backed up — without it encrypted blobs cannot be decrypted. ETags remain the MD5 of the *plaintext* so S3 clients still see familiar hashes; a truncated or tampered blob fails GCM authentication rather than returning partial data. Blobs are streamed through the cipher, never buffered in memory.
- **SQLite tuning** — WAL journal mode, `synchronous=NORMAL`, `busy_timeout=5000` applied at boot so concurrent multipart-part and admin writes don't hit `SQLITE_BUSY`.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` drains in-flight requests via `fastify.close()` before exiting (with a 15s force-exit safety net), so `systemctl restart` doesn't cut active transfers mid-stream.
- **Security headers** — CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, HSTS (`max-age=15552000; includeSubDomains`), referrer policy, and more via `@fastify/helmet`.
- **CORS disabled globally** — only object-serving endpoints (`/s3/...` GET/PUT and public CDN routes) send `Access-Control-Allow-Origin`, so CDN embedding keeps working while admin/S3 XML endpoints reject browser cross-origin reads.
- **Orphan cleanup** — on boot and hourly, the backend deletes `.tmp-*` files older than 1 hour, abandoned multipart uploads older than 24 hours (parts on disk + database rows), expired admin sessions, and request-log/failed-login/audit-log rows older than `LOG_RETENTION_DAYS`. Interrupted uploads also delete their own temp file immediately, so aborted transfers can't fill the disk.

---

## 10. Backups

Everything for an instance lives in `/var/lib/<INSTANCE>`:

```bash
# one-liner tar backup (database is SQLite — consistent enough for a hot backup)
tar czf r2storage-$(date +%F).tar.gz /var/lib/<INSTANCE>

# or rsync to another machine
rsync -avz --delete /var/lib/<INSTANCE>/ backup-host:/backups/r2storage/<INSTANCE>/
```

Schedule with cron (`crontab -e`):

```
0 3 * * * tar czf /backups/r2storage-$(date +%F).tar.gz /var/lib/<INSTANCE> && \
  find /backups -name 'r2storage-*' -mtime +14 -delete
```

Or install the bundled job — **per instance**, so co-located instances each get their own backup script and cron line (same thing, idempotent):

```bash
sudo bash deploy/backup-cron.sh /var/lib/<INSTANCE> <INSTANCE>   # or: ./deploy.sh --backups
```

> A single VPS disk has no redundancy. Restore = extract the archive to the same path, then `systemctl restart <INSTANCE>`.

---

## 11. Upgrading

```bash
cd /opt/<INSTANCE>
git pull
cd backend && npm install && npm run build
cd ../frontend && npm install && npm run build
mkdir -p ../backend/dist/public && cp -R dist/. ../backend/dist/public/
systemctl restart <INSTANCE>
```

Or simply re-run `./deploy.sh` with the same `INSTANCE` (upgrades in place, keeps secrets/data). The SQLite schema is applied automatically on service start (`ExecStartPre: npx prisma db push`). No code changes needed in nginx. Back up `/var/lib/<INSTANCE>` first.

---

## 12. Security hardening checklist

- [ ] `ADMIN_SECRET` is long and random (script generates 64 hex chars) and lives only in `/etc/<INSTANCE>/env` (root-only, `chmod 600`).
- [ ] Dashboard login uses the session cookie: `curl -I https://panel.…/api/admin/session` returns `{"authenticated":false}`, and `POST /api/admin/login` sets an `HttpOnly; SameSite=strict` cookie; the secret header still works for scripts.
- [ ] Backend binds `127.0.0.1:<PORT>`; the instance port is not open on the firewall.
- [ ] HTTPS works on all public hosts via the Cloudflare origin cert; Cloudflare SSL/TLS = **Full (strict)**.
- [ ] `80`/`443` are restricted to Cloudflare's IP ranges so `CF-Connecting-IP` (used for rate limiting) can't be spoofed.
- [ ] `systemd-analyze security <INSTANCE>` reports `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`, and friends are on (the unit sets them; the backend's *only* write paths are `/opt/<INSTANCE>/backend` and `/var/lib/<INSTANCE>`).
- [ ] Access keys use least privilege (`READ_ONLY` for downloads, `WRITE_ONLY` for uploads) plus a `bucketFilter` where possible.
- [ ] Only buckets you actually want world-readable are set **Public**.
- [ ] `deploy.sh` is run from the repo root; env secrets are never committed.
- [ ] Backups run on a schedule and are stored off-box.
- [ ] Confirm rate limiting responds `429` after ~30 failed admin logins (`curl -I https://panel.…/api/admin/login`).
- [ ] Confirm `curl -I https://panel.…/api/admin/overview` shows `Strict-Transport-Security` / `X-Content-Type-Options` and **no** `Access-Control-Allow-Origin`.
- [ ] `npm test` (the smoke suite) passes from the repo root.

---

## 13. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `https://cdn.<domain>` never resolves / DNS not found | A record missing or not propagated — `dig +short cdn.<domain>`. |
| Cloudflare 522/525 | Origin (nginx) unreachable or TLS mismatch. Check `systemctl status nginx`, `journalctl -u nginx`; confirm the origin cert paths are right and SSL/TLS mode is **Full (strict)**. |
| `nginx -t` fails with "cannot load certificate" | Origin cert/key not at `/etc/ssl/cloudflare/<domain>.{pem,key}` — fix the paths in the site config or place the files. |
| `nginx -t` fails with "upstream ... is already defined" | Two instance configs used the same `__PORT__` (the upstream is keyed by port). Give each instance a distinct `PORT`. |
| `nginx -t` warns `"listen ... http2" directive is deprecated` | Harmless on nginx ≥1.25 — the shipped config's `listen ... ssl http2` syntax is for older distros (Ubuntu 22.04's 1.18) and still works. |
| Dashboard reachable but `https://cdn.…/<key>` returns the dashboard HTML | Domain not mapped in the control panel, or the bucket is private. Map it and set the bucket Public. |
| `InvalidAccessKeyId` / `SignatureDoesNotMatch` | Wrong endpoint path (must end in `/s3`), wrong region (use `us-east-1`), or wrong secret. See `API.md` § 1–3. |
| Large uploads fail with 413 | nginx `client_max_body_size` — the shipped config sets `0` (unlimited); if you trimmed it, restore it. |
| "Host header must be signed" | Custom client signs an `Authorization` header without `host` in `SignedHeaders`. AWS SDKs/CLI do this correctly. |
| Storage full / writes fail | VPS disk full — check `df -h`; run section 10 backups. |
| Dashboard logs me out during a session | Session expired (`ADMIN_SESSION_TTL_HOURS`, default 24h) or revoked server-side (restart/redeploy doesn't clear it — logout or expiry does). Log in again. |
| `Session cookie` isn't set on `POST /api/admin/login` | The cookie is only set on success, and only sent over HTTPS in production (`NODE_ENV=production`). Over plain HTTP the cookie is still usable in dev. |
| App won't start / logs empty | `journalctl -u <INSTANCE> -e`; confirm `/etc/<INSTANCE>/env` exists and is `chmod 600`, and `/var/lib/<INSTANCE>` is writable by the service user. |

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
