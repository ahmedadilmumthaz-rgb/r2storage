import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

export async function initDb(): Promise<void> {
  await db.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await db.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
  await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  await db.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
}
