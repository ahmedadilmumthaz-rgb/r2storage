# R2 Storage SaaS Control Plane (`platform/`)

The optional **multi-tenant layer** for [r2storage](../README.md). A Next.js control
plane that turns the single-tenant S3-compatible backend into a product:
customers sign up, get a **private containerized storage instance** provisioned
automatically, are metered and billed per plan, and can mount their own custom
domains.

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

> **Portfolio context.** This is a complete reference for building a
> container-provisioning + billing control plane, not a commercial R2
> competitor — it is designed for a single VPS and lacks multi-region
> durability. The **baremetal single-tenant deploy** ([DEPLOYMENT.md](../DEPLOYMENT.md))
> remains the recommended way to actually store things.

## What it does

- **Signup → auto-provisioning**: a customer signup triggers `docker run` with
  quota flags, waits for health, creates the default bucket + API keys, writes
  the nginx host map and reloads — with rollback on failure.
- **Per-tenant containers**: each tenant runs the compiled backend on its own
  loopback port (`41001–41499`), with isolated SQLite + blobs, resource caps
  (`--memory 1g --cpus 1`, read-only rootfs), and Host-header routing.
- **Plans & quotas**: Free / Pro / Enterprise tiers; storage quotas pushed to
  the container at provision time and on plan change (writes over limit → HTTP
  507).
- **Metering & billing**: usage snapshots polled per tenant; optional Stripe
  subscription checkout + webhook sync (cancellation downgrades to Free).
- **Operator console**: live per-tenant health/latency and quota at
  `panel.<PLATFORM_DOMAIN>`.

## Tech

- **Next.js (App Router)** + Prisma/SQLite, plain Tailwind. No CSS framework.
- The tenant backend image is built from [`backend/Dockerfile`](../backend/Dockerfile)
  (`r2storage:latest`) — a multi-stage build running as uid 10001.

## Getting started (dev)

```bash
cp .env.example .env    # set OPERATOR_EMAIL / OPERATOR_PASSWORD / SECRETS
npm install
npx prisma db push
npm run dev             # http://localhost:3000 (loopback)
```

Then the E2E smoke suite (from repo root, against the running platform):

```bash
npm run test:platform
```

## Production deploy (VPS)

Installer + runbook: **[PLATFORM.md](PLATFORM.md)** — one command:

```bash
PLATFORM_DOMAIN=r2platform.com OPERATOR_EMAIL=ops@r2platform.com \
OPERATOR_PASSWORD='a-strong-password' sudo bash deploy/platform-deploy.sh
```
