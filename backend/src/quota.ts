import { db } from './db';
import { CONFIG } from './config';

const STORAGE_LIMIT_KEY = 'storage_bytes_limit';

// Effective storage quota in bytes (0 = unlimited). A persisted Setting wins
// over the boot-time STORAGE_QUOTA_BYTES env default.
export async function getStorageQuota(): Promise<number> {
  const setting = await db.setting.findUnique({ where: { key: STORAGE_LIMIT_KEY } });
  if (!setting) return CONFIG.STORAGE_QUOTA_BYTES;
  const v = parseInt(setting.value, 10);
  return Number.isNaN(v) || v < 0 ? 0 : v;
}

export async function setStorageQuota(bytes: number): Promise<void> {
  const v = Math.max(0, Math.floor(bytes));
  await db.setting.upsert({
    where: { key: STORAGE_LIMIT_KEY },
    create: { key: STORAGE_LIMIT_KEY, value: String(v) },
    update: { value: String(v) },
  });
}

// Logical bytes currently stored (sum of object sizes in the metadata DB).
export async function usedStorageBytes(): Promise<number> {
  const r = await db.object.aggregate({ _sum: { size: true } });
  return r._sum.size || 0;
}

// True when committing `addedBytes` (net of the `removedBytes` being replaced,
// e.g. an overwritten object) would push the tenant over quota.
export async function wouldExceedQuota(addedBytes: number, removedBytes = 0): Promise<boolean> {
  const quota = await getStorageQuota();
  if (quota <= 0) return false;
  const used = await usedStorageBytes();
  return used - removedBytes + addedBytes > quota;
}
