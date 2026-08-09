import path from 'path';

export const ENV = {
  // Absolute, because the Prisma CLI resolves relative `file:` URLs against the
  // schema directory while the runtime client resolves them against cwd — the
  // two would otherwise target different files.
  DATABASE_URL:
    process.env.DATABASE_URL || `file:${path.join(process.cwd(), 'prisma/dev.db')}`,
  PLATFORM_DOMAIN: process.env.PLATFORM_DOMAIN || 'r2platform.com',
  PLATFORM_BASE_URL: (process.env.PLATFORM_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  PLATFORM_MASTER_KEY: process.env.PLATFORM_MASTER_KEY || '',
  SESSION_TTL_HOURS: parseInt(process.env.SESSION_TTL_HOURS || '168', 10),

  CF_API_TOKEN: process.env.CF_API_TOKEN || '',
  CF_ZONE_ID: process.env.CF_ZONE_ID || '',
  CF_FALLBACK_ORIGIN: process.env.CF_FALLBACK_ORIGIN || 'origin.r2platform.com',

  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'R2 Storage <no-reply@r2platform.com>',

  // Stripe billing. Leave unset for metering-only mode; checkout/portal then
  // return 501 and the dashboard shows "billing coming soon".
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO || '',

  NODE_ENV: process.env.NODE_ENV || 'development',

  TENANT_STORAGE_BASE: process.env.TENANT_STORAGE_BASE || '/srv/r2storage/tenants',
  R2_IMAGE: process.env.R2_IMAGE || 'r2storage:latest',
  // Empty string disables map writing (dev); only the default path enables it.
  NGINX_MAP_FILE: process.env.NGINX_MAP_FILE ? process.env.NGINX_MAP_FILE : null,
  NGINX_RELOAD: process.env.NGINX_RELOAD !== 'false',
  TENANT_PORT_MIN: parseInt(process.env.TENANT_PORT_MIN || '41001', 10),
  TENANT_PORT_MAX: parseInt(process.env.TENANT_PORT_MAX || '41499', 10),
  MAX_INSTANCES_PER_CUSTOMER: parseInt(process.env.MAX_INSTANCES_PER_CUSTOMER || '1', 10),
  MAX_ACTIVE_INSTANCES: parseInt(process.env.MAX_ACTIVE_INSTANCES || '50', 10),

  OPERATOR_EMAIL: process.env.OPERATOR_EMAIL || '',
  OPERATOR_PASSWORD_HASH: process.env.OPERATOR_PASSWORD_HASH || '',

  METER_KEY: process.env.METER_KEY || '',
  METERING_INTERVAL_MS: parseInt(process.env.METERING_INTERVAL_MS || '3600000', 10),
};
