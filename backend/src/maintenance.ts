import fs from 'fs';
import path from 'path';
import { CONFIG } from './config';
import { db } from './db';
import { storageEngine } from './storage/engine';

const TMP_SWEEP_AGE_MS = 60 * 60 * 1000; // 1 hour
const MULTIPART_SWEEP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function sweepTmpFiles(): Promise<number> {
  const cutoff = Date.now() - TMP_SWEEP_AGE_MS;
  const now = new Date();
  let removed = 0;

  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.includes('.tmp-')) {
        const stat = await fs.promises.stat(fullPath).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await fs.promises.unlink(fullPath).catch(() => {});
          removed++;
        }
      }
    }
  }

  if (fs.existsSync(CONFIG.STORAGE_DIR)) {
    await walk(CONFIG.STORAGE_DIR);
  }

  if (removed > 0) {
    console.log(`[maintenance] removed ${removed} stale tmp file(s) (${now.toISOString()})`);
  }
  return removed;
}

async function sweepAbandonedMultipartUploads(): Promise<number> {
  const cutoff = new Date(Date.now() - MULTIPART_SWEEP_AGE_MS);
  const uploads = await db.multipartUpload.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { uploadId: true },
  });

  for (const { uploadId } of uploads) {
    await storageEngine.deleteUploadParts(uploadId).catch(() => {});
    await db.multipartUpload.delete({ where: { uploadId } }).catch(() => {});
  }

  if (uploads.length > 0) {
    console.log(`[maintenance] removed ${uploads.length} abandoned multipart upload(s) (${new Date().toISOString()})`);
  }
  return uploads.length;
}

async function sweepRequestLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - CONFIG.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db.requestLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (deleted.count > 0) {
    console.log(`[maintenance] pruned ${deleted.count} request log row(s) older than ${CONFIG.LOG_RETENTION_DAYS} days`);
  }
  return deleted.count;
}

async function sweepFailedLogins(): Promise<number> {
  const cutoff = new Date(Date.now() - CONFIG.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db.failedLogin.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (deleted.count > 0) {
    console.log(`[maintenance] pruned ${deleted.count} failed-login row(s) older than ${CONFIG.LOG_RETENTION_DAYS} days`);
  }
  return deleted.count;
}

async function sweepAuditLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - CONFIG.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db.auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (deleted.count > 0) {
    console.log(`[maintenance] pruned ${deleted.count} audit-log row(s) older than ${CONFIG.LOG_RETENTION_DAYS} days`);
  }
  return deleted.count;
}

async function sweepExpiredSessions(): Promise<number> {
  const deleted = await db.adminSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  if (deleted.count > 0) {
    console.log(`[maintenance] removed ${deleted.count} expired admin session(s) (${new Date().toISOString()})`);
  }
  return deleted.count;
}

export async function runMaintenanceSweep(): Promise<void> {
  await sweepTmpFiles();
  await sweepAbandonedMultipartUploads();
  await sweepRequestLogs();
  await sweepFailedLogins();
  await sweepAuditLogs();
  await sweepExpiredSessions();
}

export function startMaintenanceSweeper(): void {
  runMaintenanceSweep().catch((err) => console.error('[maintenance] initial sweep failed:', err));
  const interval = setInterval(() => {
    runMaintenanceSweep().catch((err) => console.error('[maintenance] sweep failed:', err));
  }, SWEEP_INTERVAL_MS);
  interval.unref();
}
