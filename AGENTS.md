# AGENTS.md — Working on this repository

Guidance for humans **and AI coding agents** (opencode, Claude Code, Cursor, ...)
working in this repo. Read this before editing anything.

## What this project is

Self-hosted, **S3/R2-compatible object storage** that runs on your own VPS, plus an
optional **multi-tenant SaaS control plane**. It is a portfolio/private-use
project — not a commercial R2 competitor.

Two deployment modes:

- **Baremetal (primary, recommended):** the compiled backend + React panel run
  natively on a VPS under systemd + nginx. One instance per project (own port,
  domain, data, backups) or one shared instance at `cdn.<domain>`.
- **Containerized SaaS (optional, `platform/`):** a Next.js control plane
  provisions one Docker container per customer (quota flags, isolated DB/blobs,
  Host-header routing), meters usage, and bills via Stripe.

## Repo layout

```
backend/          Fastify S3/R2 backend + Prisma/SQLite (the core product)
  src/index.ts      server bootstrap: helmet, CORS(off), rate limits, streaming parsers
  src/config.ts     env config (HOST defaults to 127.0.0.1 — do not loosen)
  src/api/s3.ts     S3 protocol: PUT/GET/HEAD/DELETE/list/multipart/presigned
  src/api/admin.ts  dashboard API + usage/quota metering endpoints
  src/api/auth.ts   admin login → HttpOnly session cookie
  src/auth/         SigV4 verification (s3auth.ts), constant-time secrets, sessions
  src/storage/      hash-addressed blob engine (sha256 paths, streamed writes)
  src/quota.ts      storage quota enforcement (HTTP 507)
  src/maintenance.ts orphan tmp / multipart / log / session sweeps
  prisma/           schema
frontend/         Vite + React control panel (dark mode), built into backend/dist
platform/         Next.js SaaS control plane (signup, provisioning, metering, Stripe)
  app/api/           Next.js route handlers (billing, instances, meter, usage, ...)
  lib/               provision.ts, nginx.ts, usage.ts, stripe.ts, session.ts, ...
deploy/           baremetal nginx/systemd templates + SaaS VPS installer
deploy.sh         parameterized baremetal installer (INSTANCE/PORT/BASE_DOMAIN)
scripts/          smoke.sh (backend, 71 checks), platform-smoke.sh, sec-check.sh
examples/         integration recipes (browser-upload, nextjs-uploader, laravel, ...)
```

## Commands

```bash
npm install --prefix backend && npm install --prefix frontend   # deps
npm run build            # tsc backend + vite frontend
npm test                 # scripts/smoke.sh — boots a throwaway backend, 71 checks
npm run test:platform    # platform E2E smoke (needs a running platform first)
npm run lint --prefix platform    # eslint (platform only; backend/frontend have no lint)
bash scripts/sec-check.sh         # ad-hoc security spot-checks (spins a temp server)
npm run dev:backend / dev:frontend
```

- **Node 20** (see `.nvmrc`). Backend: TypeScript → `dist/index.js`. Frontend:
  Vite → `backend/dist/public`-adjacent layout consumed by the backend server.
- Before running smoke tests, the backend must be built (`npm run build`).
- Verification loop after any change: `npm run build --prefix backend && npm test`.

## Conventions

- **TypeScript everywhere.** Match existing style; no classes where functions do.
- **Comments explain *why*, not *what*.** Existing files have deliberate prose
  around security-sensitive decisions — preserve it.
- **Never commit secrets.** `.env` files are gitignored; only `.env.example`
  templates are committed.
- **Security-first review.** See the hardening rules below — treat the security
  posture as an invariant, not a suggestion.

## Security posture (treat as invariants)

These are the load-bearing security decisions. **Do not weaken them without an
explicit, reviewed reason.**

1. **Loopback binding.** `HOST` defaults to `127.0.0.1`. The backend is only ever
   reachable through nginx (which sets `X-Forwarded-For` from Cloudflare's
   `CF-Connecting-IP`). Never default HOST to `0.0.0.0` — it defeats the
   nginx auth/rate-limit boundary. (Docker images set `HOST=0.0.0.0` explicitly
   because the container itself is loopback-only.)
2. **Credentials.** An **Access Key ID is NOT a secret** — it appears in presigned
   URLs and the dashboard. Header convenience auth (`x-access-key-id` +
   `x-access-key-secret`, or `x-api-key: <secret>`) must verify the **secret**
   with constant-time comparison. A bare `x-access-key-id` must keep returning
   403.
3. **SigV4.** All signatures verified with `crypto.timingSafeEqual`. Requests
   outside a 15-minute timestamp skew are rejected (replay protection); presigned
   URLs must not accept future-dated `X-Amz-Date`, and their lifetime is capped
   at 7 days at the admin API.
 4. **Admin auth.** `ADMIN_SECRET` is compared constant-time; in production the
    server **refuses to boot** with the default secret (fail closed). Sessions are
    random tokens stored server-side as SHA-256 hashes in HttpOnly
    `SameSite=Strict` cookies, revoked on logout and expired by maintenance.
    Sessions slide-renew on activity but are hard-capped at
    `ADMIN_SESSION_MAX_HOURS` (`session.ts: sessionExpiry`).
    Wrong-secret logins are throttled by an escalating lockout (`lockout.ts`:
    per-IP block + doubling global cooldown, capped) and written to a
    `FailedLogin` audit table; privileged admin actions land in an `AuditLog`
    table (`audit.ts`, surfaced at `GET /api/admin/audit`) with the auth source
    recorded. Extend `scripts/smoke.sh` / `sec-check.sh` when touching this
    behavior.
5. **Object storage.** Blobs are stored under sha256-derived paths — a key can
   never traverse directories. Quota is enforced pre-write (Content-Length) and
   post-write (HTTP 507), and at multipart `UploadPart` time (parts consume disk
   before completion). Optional AES-256-GCM encryption at rest
   (`STORAGE_ENCRYPTION_KEY`, 64 hex chars) transparently encrypts every new
   blob with a per-object random IV (magic `r2enc1` + IV header); legacy
   plaintext blobs stay readable via magic detection (`storage/crypto.ts`).
   Request XML is parsed via regex only — no XML parser, so no XXE; all XML
   responses escape interpolated values.
6. **Server config.** CORS is disabled globally (`origin: false`); only object
   routes set `Access-Control-Allow-Origin`. `@fastify/helmet` headers are on.
   Rate limits key off the client IP and are per-scope (admin 30/min,
   s3 600/min, global 300/min). Optional `ADMIN_ALLOWED_CIDRS` gates the whole
   admin API — login included — at the root (`allowlist.ts`), keyed off the same
   client IP.
7. **Deployment.** Keep the backend loopback-only in systemd (deploy.sh already
   renders `HOST=127.0.0.1`); TLS is always terminated at nginx with a Cloudflare
   origin cert; `deploy/r2storage.service` ships with sandboxing options.

When touching any of these areas, extend **scripts/smoke.sh** with a check that
proves the property (see the `auth hardening` section).

## Architecture notes an agent will need

- **`/s3/:bucket/*`** is the real S3 API (SigV4 + presigned + header auth). The
  frontend talks to `/api/admin/*` with a session cookie. Public bucket objects
  are also served on custom-domain hosts (`cdn.<domain>/<key>`,
  `<bucket>.<domain>/<key>`) via `tryServePublicObject`.
- **Multipart uploads** go through `storageEngine` (`savePartFromStream` →
  `assembleUpload`), with DB rows in `MultipartUpload`/`MultipartPart`; abandoned
  uploads are swept by `maintenance.ts`.
- **Platform metering** polls `GET /api/admin/usage?since=` and
  `GET /api/admin/quota`; the container backend enforces the quota set via
  `PATCH /api/admin/quota`.
- **Data is single-VPS.** Everything (SQLite + blobs) lives under
  `/var/lib/<INSTANCE>` in baremetal mode; backups are per-instance via
  `deploy/backup-cron.sh`.

## Documentation map

| File | Purpose |
|---|---|
| `README.md` | Product overview, architecture, quickstart (portfolio-facing) |
| `DEPLOYMENT.md` | Baremetal VPS runbook (nginx, Cloudflare origin cert, backups, hardening) |
| `API.md` | S3 + Admin API reference with SDK samples |
| `USAGE.md` | Framework recipes + examples/ |
| `PLATFORM.md` | SaaS control plane architecture + VPS installer |
| `platform/README.md` | Platform dev quickstart |

## Git workflow

- Branch is `main`. Keep commits small and scoped; match the existing message
  style (imperative, e.g. "Parameterize baremetal deploy for per-project instances").
- Do not commit unless asked. Tag releases (`git tag v1.0` exists).
- CI (`.github/workflows/ci.yml`) runs backend build + smoke and platform
  lint + build on push/PR to `main`.
