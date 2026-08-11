import fs from 'fs';
import path from 'path';
import { CONFIG } from './config';
import { db } from './db';
import { storageEngine } from './storage/engine';
import { deserializeLifecycleRules } from './api/lifecycle';

const TMP_SWEEP_AGE_MS = 60 * 60 * 1000; // 1 hour
const MULTIPART_SWEEP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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

// Lifecycle expiration: for every bucket rule with Status=Enabled, delete
// objects whose key matches the rule's prefix and whose Last-Modified (the
// object row's updatedAt) is past the rule's cutoff. Age is measured from the
// object's most recent write, matching S3's Last-Modified semantics. Rows with
// a future expiration date are skipped until they mature.
async function sweepExpiredObjects(): Promise<number> {
  const buckets = await db.bucket.findMany({ select: { name: true, lifecycleRules: true } });
  const now = Date.now();
  let removed = 0;

  for (const bucket of buckets) {
    const rules = deserializeLifecycleRules(bucket.lifecycleRules);
    if (rules.length === 0) continue;

    const idsToDelete = new Set<string>();
    const pathsToDelete = new Map<string, string>();
    for (const rule of rules) {
      if (rule.status !== 'Enabled') continue;
      let cutoff: Date | null = null;
      let expiresAll = false;
      if (rule.days !== undefined) {
        cutoff = new Date(now - rule.days * 24 * 60 * 60 * 1000);
      } else if (rule.date !== undefined) {
        // Expiration on a date means the whole calendar day (midnight UTC): the
        // object is expired once the date has passed, whatever its Last-Modified.
        const endOfDay = new Date(`${rule.date}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
        if (endOfDay > now) continue; // rule matures in the future
        expiresAll = true;
      }
      if (!cutoff && !expiresAll) continue;

      const where: { bucketName: string; key?: { startsWith: string }; updatedAt?: { lt: Date } } = {
        bucketName: bucket.name,
      };
      if (rule.prefix) where.key = { startsWith: rule.prefix };
      if (cutoff) where.updatedAt = { lt: cutoff };

      const objects = await db.object.findMany({
        where,
        select: { id: true, storagePath: true },
      });
      for (const o of objects) {
        idsToDelete.add(o.id);
        pathsToDelete.set(o.id, o.storagePath);
      }
    }

    for (const id of idsToDelete) {
      const storagePath = pathsToDelete.get(id);
      if (storagePath) await storageEngine.deleteObjectFile(storagePath);
      await db.object.delete({ where: { id } }).catch(() => {});
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[maintenance] lifecycle-expired ${removed} object(s) (${new Date().toISOString()})`);
  }
  return removed;
}

export async function runMaintenanceSweep(): Promise<void> {
  await sweepTmpFiles();
  await sweepAbandonedMultipartUploads();
  await sweepExpiredObjects();
  await sweepRequestLogs();
  await sweepFailedLogins();
  await sweepAuditLogs();
  await sweepExpiredSessions();
}

export function startMaintenanceSweeper(): void {
  runMaintenanceSweep().catch((err) => console.error('[maintenance] initial sweep failed:', err));
  const interval = setInterval(() => {
    runMaintenanceSweep().catch((err) => console.error('[maintenance] sweep failed:', err));
  }, CONFIG.MAINTENANCE_SWEEP_INTERVAL_MS);
  interval.unref();
}
