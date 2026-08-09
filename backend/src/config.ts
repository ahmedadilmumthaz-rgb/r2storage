import path from 'path';

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  DATABASE_URL: process.env.DATABASE_URL || 'file:./dev.db',
  STORAGE_DIR: process.env.STORAGE_DIR || path.join(process.cwd(), 'data_storage'),
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'r2storage-admin-secret-key-change-me',
  BASE_DOMAIN: process.env.BASE_DOMAIN || 'localhost',
  RATE_LIMIT_GLOBAL: parseInt(process.env.RATE_LIMIT_GLOBAL || '300', 10),
  RATE_LIMIT_ADMIN: parseInt(process.env.RATE_LIMIT_ADMIN || '30', 10),
  RATE_LIMIT_S3: parseInt(process.env.RATE_LIMIT_S3 || '600', 10),
  LOG_RETENTION_DAYS: parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
  ADMIN_SESSION_TTL_HOURS: parseInt(process.env.ADMIN_SESSION_TTL_HOURS || '24', 10),
  // Storage quota in bytes; 0 = unlimited. Overridable at runtime via
  // PATCH /api/admin/quota (persisted in the Setting table).
  STORAGE_QUOTA_BYTES: parseInt(process.env.STORAGE_QUOTA_BYTES || '0', 10),
  IS_PRODUCTION: process.env.NODE_ENV === 'production',
};
