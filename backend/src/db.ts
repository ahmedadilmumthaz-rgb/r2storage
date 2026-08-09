import { PrismaClient } from '@prisma/client';

export const db = new PrismaClient();

/**
 * Tune SQLite for server concurrency. Runs once at boot, before any queries:
 * - WAL: readers don't block writers (multipart parts + admin ops can run together).
 * - synchronous=NORMAL: safe with WAL, keeps writes fast on a VPS disk.
 * - busy_timeout: wait up to 5s for a locked database instead of failing fast.
 * - foreign_keys=ON: Prisma enables this per-connection anyway; keep it explicit.
 */
export async function initDatabase(): Promise<void> {
  await db.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await db.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
  await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  await db.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
}
