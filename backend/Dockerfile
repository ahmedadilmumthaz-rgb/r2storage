# r2storage tenant image — the existing Fastify backend + built dashboard UI,
# bundled so one container per tenant can be run with its own volume, env, and
# loopback-published port.

# syntax=docker/dockerfile:1

########## Build stage ##########
FROM node:20-bookworm-slim AS build
WORKDIR /build

# openssl makes Prisma's platform detection resolve to debian-openssl-3.0.x
# (matches the runtime stage); without it, engines fall back to 1.1.x and
# `prisma db push` fails at runtime with "Could not find schema-engine binary".
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Backend dependencies (npm ci needs the lockfile; NODE_ENV unset so dev
# deps — including the `prisma` CLI — are installed for `db push` at runtime).
COPY backend/package.json backend/package-lock.json ./backend/
WORKDIR /build/backend
RUN npm ci

# Frontend dependencies
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./frontend/
WORKDIR /build/frontend
RUN npm ci

# Build backend (generate Prisma client first, then compile TS)
WORKDIR /build/backend
COPY backend/prisma ./prisma
COPY backend/src ./src
COPY backend/tsconfig.json ./
RUN npx prisma generate && npm run build

# Build dashboard UI
WORKDIR /build/frontend
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts frontend/tailwind.config.js frontend/postcss.config.js ./
COPY frontend/src ./src
RUN npm run build

########## Runtime stage ##########
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

# openssl: Prisma engine dependency. ca-certificates + curl: /health probe.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 r2 \
    && useradd --system --uid 10001 --gid r2 --no-create-home --shell /sbin/nologin r2

COPY --from=build /build/backend/package.json /build/backend/package-lock.json ./
COPY --from=build /build/backend/node_modules ./node_modules
COPY --from=build /build/backend/dist ./dist
COPY --from=build /build/backend/prisma ./prisma
# Served by the backend at dist/../frontend/dist (matches the host layout)
COPY --from=build /build/frontend/dist ./frontend/dist
COPY backend/docker/entrypoint.sh ./entrypoint.sh

RUN mkdir -p /var/lib/r2storage \
    && chmod +x ./entrypoint.sh \
    && chown -R r2:r2 /app /var/lib/r2storage

USER r2
EXPOSE 4000
VOLUME /var/lib/r2storage

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]
