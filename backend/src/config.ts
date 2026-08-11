import path from 'path';

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  // Loopback by default: the backend must only be reachable through nginx
  // (which sets X-Forwarded-For from Cloudflare's CF-Connecting-IP). Binding
  // 0.0.0.0 would expose the raw backend on all interfaces, defeating the
  // nginx rate-limit/auth boundary. Docker images set HOST=0.0.0.0 explicitly
  // (loopback inside the container), and local dev can override in .env.
  HOST: process.env.HOST || '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL || 'file:./dev.db',
  STORAGE_DIR: process.env.STORAGE_DIR || path.join(process.cwd(), 'data_storage'),
  // Optional AES-256-GCM blob encryption key (64 hex chars = 32 bytes). Empty =
  // plaintext blobs (backward compatible). When set, every new blob is encrypted
  // at rest with a per-object random IV; existing plaintext blobs stay readable.
  STORAGE_ENCRYPTION_KEY: process.env.STORAGE_ENCRYPTION_KEY || '',
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'r2storage-admin-secret-key-change-me',
  // Optional TOTP base32 secret (RFC 6238, e.g. Google Authenticator). When set,
  // the dashboard login requires a valid 6-digit code in the `totp` field on top
  // of ADMIN_SECRET. Machine access via the x-admin-secret header is exempt (it
  // already carries a long random secret). Generate with: openssl rand -base64 20
  ADMIN_TOTP_SECRET: process.env.ADMIN_TOTP_SECRET || '',
  BASE_DOMAIN: process.env.BASE_DOMAIN || 'localhost',
  // Optional comma-separated CIDRs (IPv4/IPv6) that may reach /api/admin/*
  // including login; empty = allow all. Enforced via req.ip (CF-Connecting-IP).
  ADMIN_ALLOWED_CIDRS: process.env.ADMIN_ALLOWED_CIDRS || '',
  // Server-level socket timeouts (slowloris defense-in-depth; nginx guards the
  // edge, these bound a raw backend socket). Node http defaults are 60s headers
  // / 5min request; these close idle connections and make the limits explicit.
  SERVER_CONNECTION_TIMEOUT_MS: parseInt(process.env.SERVER_CONNECTION_TIMEOUT_MS || '30000', 10), // idle socket
  SERVER_HEADERS_TIMEOUT_MS: parseInt(process.env.SERVER_HEADERS_TIMEOUT_MS || '30000', 10),
  SERVER_REQUEST_TIMEOUT_MS: parseInt(process.env.SERVER_REQUEST_TIMEOUT_MS || '600000', 10), // raise for slow large uploads
  RATE_LIMIT_GLOBAL: parseInt(process.env.RATE_LIMIT_GLOBAL || '300', 10),
  RATE_LIMIT_ADMIN: parseInt(process.env.RATE_LIMIT_ADMIN || '30', 10),
  RATE_LIMIT_S3: parseInt(process.env.RATE_LIMIT_S3 || '600', 10),
  LOG_RETENTION_DAYS: parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
  // Float hours so tests and deployments can use sub-hour lifetimes (e.g. 0.01h).
  ADMIN_SESSION_TTL_HOURS: parseFloat(process.env.ADMIN_SESSION_TTL_HOURS || '24'),
  // Absolute cap on a session's lifetime regardless of activity. Sliding renewal
  // (each authenticated request extends expiry to now+TTL) can never push past
  // this ceiling, so an abandoned-but-forever-polled session still dies.
  ADMIN_SESSION_MAX_HOURS: parseFloat(process.env.ADMIN_SESSION_MAX_HOURS || '168'), // 7 days
  // Storage quota in bytes; 0 = unlimited. Overridable at runtime via
  // PATCH /api/admin/quota (persisted in the Setting table).
  STORAGE_QUOTA_BYTES: parseInt(process.env.STORAGE_QUOTA_BYTES || '0', 10),
  // Hourly by default; smoke tests boot a small value to exercise the
  // lifecycle-expiry path end-to-end without waiting an hour.
  MAINTENANCE_SWEEP_INTERVAL_MS: parseInt(process.env.MAINTENANCE_SWEEP_INTERVAL_MS || '3600000', 10),
  // Brute-force lockout for the admin login (see auth/lockout.ts).
  LOGIN_FAIL_THRESHOLD: parseInt(process.env.LOGIN_FAIL_THRESHOLD || '5', 10), // consecutive per-IP failures
  LOGIN_IP_COOLDOWN_SEC: parseInt(process.env.LOGIN_IP_COOLDOWN_SEC || '1800', 10), // 30 min per-IP block
  LOGIN_GLOBAL_THRESHOLD: parseInt(process.env.LOGIN_GLOBAL_THRESHOLD || '15', 10), // failures across all IPs
  LOGIN_GLOBAL_COOLDOWN_SEC: parseInt(process.env.LOGIN_GLOBAL_COOLDOWN_SEC || '300', 10), // 5 min, doubles on re-trigger
  LOGIN_FAILURE_DELAY_MS: parseInt(process.env.LOGIN_FAILURE_DELAY_MS || '150', 10), // fixed delay before replying 401
  IS_PRODUCTION: process.env.NODE_ENV === 'production',
};
