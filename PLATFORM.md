# R2 Storage SaaS Control Plane (`platform/`)

This is the **multi-tenant SaaS layer** for the self-hosted R2 Storage app. The
single-tenant app (in `backend/` + `frontend/`) becomes one *tenant instance*
inside a Docker container; the control plane signs customers up, provisions a
private container per customer, meters their usage, and manages their custom
domains through Cloudflare SSL for SaaS.

```
Visitor/customer
      │ HTTPS (custom domain or <tenant>.<platform-domain>)
      ▼
Cloudflare (SSL for SaaS edge certs)
      ▼
nginx (platform zone)  ──host map──▶  127.0.0.1:<port>   per-tenant Docker container
      │  map $host $r2_tenant_port;    (each app = backend/ + frontend/ build)
      │
      └── panel./origin. ──────────▶  127.0.0.1:4000    platform/ control plane
                                                          (signup, dashboard,
                                                           metering, admin)
```

## Architecture

- **Tenant instances** are one Docker container each, running the compiled
  `backend/` app on loopback port **41001–41499**, with its own volume, env, and
  admin secret. The tenant image is built from `backend/Dockerfile` as
  `r2storage:latest` (a multi-stage build: Node 20 + TypeScript backend + built
  React control panel, running as uid 10001, `--read-only` rootfs with a
  `tmpfs /tmp`).
- **The control plane** is a Next.js 16 App Router app in `platform/`. It owns
  the platform SQLite DB (`Customer`, `Session`, `Plan`, `Instance`,
  `UsageSnapshot`, `Invoice`) and every operational action: signup/verify,
  provisioning, suspend/resume/delete, metering, operator console.
- **Routing**: nginx on the platform VPS has one catch-all server that maps
  `$host` → tenant port via a generated map file. The control plane regenerates
  and reloads that map whenever an instance is provisioned/suspended/resumed/deleted.

## Directory layout

| Path | Purpose |
| --- | --- |
| `platform/prisma/` | Platform schema + seed (plans). |
| `platform/lib/` | `env`, `db`, `crypto` (AES-256-GCM), `password`, `session`, `http`, `cf` (Cloudflare Custom Hostnames), `smtp`, `nginx` (host map), `provision` (provision/suspend/resume/delete), `usage` (metering), `plans`. |
| `platform/app/` | Next.js UI + API routes (auth, instances, usage, meter, admin). |
| `platform/instrumentation.ts` | Boot-time DB init + optional metering interval. |
| `backend/Dockerfile` | Tenant image. |
| `deploy/nginx-multitenant.conf` | Catch-all nginx site template for the platform zone. |
| `deploy/r2storage-map.template` | nginx host-map template (the control plane writes the real map). |
| `deploy/tenant-run.sh` | Manual helper to run a single tenant container (used before the platform existed; the platform provisions containers itself now). |
| `scripts/smoke.sh` | 26-check tenant smoke test; `SMOKE_URL` + `ADMIN_SECRET` env overrides. |

## Local development

```bash
# 1. Build the tenant image once (used for every provisioned instance)
docker build -t r2storage:latest -f backend/Dockerfile .

# 2. Control plane
cd platform
cp .env.example .env          # dev defaults are fine
npm install
npm run db:setup              # prisma db push + seed (plans)
npm run dev                   # http://localhost:3000

# 3. Sign up at http://localhost:3000/signup
```

In dev, with `NGINX_MAP_FILE=""` and `NGINX_RELOAD=false`, provisioning still
runs the Docker container and the Cloudflare call, but skips nginx
write/reload; with no SMTP set, signup auto-verifies and returns the token
immediately (the signup page verifies itself and provisions your domain).

## Production configuration

Copy `platform/.env.example` → `.env` and set:

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | **Absolute** path to the platform SQLite DB. (Prisma CLI resolves relative `file:` URLs against the schema dir; the runtime resolves against cwd — a relative path silently splits the DB.) |
| `PLATFORM_DOMAIN` | yes | Your platform zone, e.g. `r2platform.com`. |
| `PLATFORM_MASTER_KEY` | yes | AES-256-GCM master key (`openssl rand -hex 32`) used to encrypt tenant admin secrets + initial access keys at rest. |
| `CF_API_TOKEN`, `CF_ZONE_ID` | for edge TLS | Cloudflare token (Custom Hostnames:Edit, SSL:Edit) + zone id. Without them, provisioning logs a warning and continues (no SSL-for-SaaS hostname). |
| `CF_FALLBACK_ORIGIN` | with CF | `origin.<PLATFORM_DOMAIN>` record that points at the VPS. |
| `SMTP_HOST/PORT/USER/PASS/FROM` | recommended | Sends verification + welcome emails with credentials. Unset = signup auto-verifies. |
| `OPERATOR_EMAIL`, `OPERATOR_PASSWORD_HASH` | recommended | Operator console login. See below. |
| `R2_IMAGE` | no | Tenant image name/tag (default `r2storage:latest`). |
| `TENANT_STORAGE_BASE` | no | Where tenant volume data lives on the host (default `/srv/r2storage/tenants`). |
| `NGINX_MAP_FILE` | no | Absolute path to write the nginx host map. **Empty string disables writing** (dev). |
| `NGINX_RELOAD` | no | Run `nginx -t` + reload after map writes (true in production). |
| `MAX_INSTANCES_PER_CUSTOMER`, `MAX_ACTIVE_INSTANCES` | no | Provisioning caps. |
| `METER_KEY` | no | Shared secret guarding `POST /api/meter`. |
| `METERING_INTERVAL_MS` | no | Interval of the in-process metering loop (0 = disabled). |

### Operator console

```bash
cd platform
npm run hashpw -- 'a-strong-password'   # prints a bcrypt hash
```

Put the hash in `.env` — **escape every `$` with a backslash** inside the double
quotes, or Next's env loader will expand it as a variable reference and
truncate the hash:

```
OPERATOR_EMAIL="ops@example.com"
OPERATOR_PASSWORD_HASH="\$2b\$12\$Bcbg..."
```

Log in at `/login` with that email/password → redirected to `/admin`.

The operator console lists every instance with a **Health** column: on each
load it live-probes the tenant's `/health` endpoint (5s timeout) so a container
that is crash-looping or unreachable shows `down` even though its DB status is
still `active` (`platform/lib/health.ts`). For active instances you also get
response latency; suspended/deleted instances show `—`. The dashboard's
"Poll usage now" button triggers `meterAll` for fresh usage numbers.

### Cloudflare SSL for SaaS (per-customer domains)

1. Add `PLATFORM_DOMAIN` as a zone on Cloudflare, and point
   `origin.<PLATFORM_DOMAIN>` and `panel.<PLATFORM_DOMAIN>` (A records) at your
   VPS.
2. Enable **SSL for SaaS** on the zone and add `*.<PLATFORM_DOMAIN>` as a
   custom hostname fallback origin.
3. Set the token + zone id in `.env`. Each provisioning calls
   `createCustomHostname('*.<customer-domain>')`; Cloudflare issues the edge
   cert automatically.
4. Tell customers to CNAME `cdn.<their-domain>` (and optionally
   `panel.<their-domain>`) to `origin.<PLATFORM_DOMAIN>`.

### Provisioning pipeline

`provisionInstance` in `platform/lib/provision.ts`:
validate domain/caps → pick a free port → `docker run` → wait for
`/health` (90s) → create `default` bucket + a FULL access key via the tenant
admin API → **push the plan's storage quota** (`PATCH /api/admin/quota`, also
passed as `STORAGE_QUOTA_BYTES` at container start) → register the SSL-for-SaaS
hostname (best-effort) → mark active → regenerate + reload the nginx host map.
Any failure rolls back (container removed, instance row deleted so the
domain/port are reusable).

**Quota enforcement**: the tenant app rejects object writes that would push the
instance over its quota with HTTP `507 Insufficient Storage` — on `PutObject`
(early via `Content-Length` + authoritatively after streaming), on
`CompleteMultipartUpload` (before assembling parts), and on the admin-panel
upload route. Deleting objects frees space immediately.

A customer-deleted instance is **soft-deleted**: its domain and port stay
reserved (row kept with `status = deleted`).

## nginx multitenant host map

The catch-all site (`deploy/nginx-multitenant.conf`) includes the generated map
file, e.g.:

```nginx
map $host $r2_tenant_port {
    default 0;
    "~^(r2platform.com|www\.r2platform\.com|panel\.r2platform\.com|origin\.r2platform\.com)$" 4000;
    "~^([a-z0-9-]+\.)+tenant1\.com$" 41001;
    "~^([a-z0-9-]+\.)+tenant2\.com$" 41002;
}
```

Any Host header not in the map resolves to port `0` → the catch-all returns 404,
which blocks host-header spoofing against the platform.

## Metering

Each tenant exposes `GET /api/admin/usage?since=<iso>` (storage bytes,
request count, bytes transferred, incremental). The control plane polls it
(`platform/lib/usage.ts`), stores `UsageSnapshot` rows, and surfaces the latest
snapshot + plan limits on the customer dashboard and operator console. Trigger
a poll manually with `POST /api/meter` (needs `METER_KEY`), or leave the
interval running.

## Backups

Back up the platform DB (`DATABASE_URL` file), the tenant volumes
(`TENANT_STORAGE_BASE`), and `.env` (contains `PLATFORM_MASTER_KEY` — without
it the encrypted tenant secrets cannot be decrypted). `rsync`/borg/restic all
work; a Docker socket file or shell script can snapshot volumes by container.

## Testing

- Tenant image: `docker build -t r2storage:latest -f backend/Dockerfile .` then
  `SMOKE_URL=http://127.0.0.1:<port> ADMIN_SECRET=<secret> scripts/smoke.sh`
  against a running container.
- Control plane: `cd platform && npm run lint && npm run build`, then the E2E
  flow: signup → verify (auto) → `POST /api/instances` → check the container
  `docker ps` → `GET /api/instances` / `/api/usage` → suspend/resume/delete.
