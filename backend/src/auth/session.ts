import crypto from 'crypto';
import { db } from '../db';
import { CONFIG } from '../config';

export const SESSION_COOKIE = 'r2_admin_sid';

/**
 * Expiry for a session, given its creation time and the current time. Sliding
 * renewal moves the expiry to now+TTL on activity, but never beyond the absolute
 * ceiling created+MAX — so an idle session dies after TTL and any session dies
 * after MAX, even one kept alive by a polling dashboard.
 */
export function sessionExpiry(createdAt: Date, now: Date): Date {
  const ttlMs = CONFIG.ADMIN_SESSION_TTL_HOURS * 3600 * 1000;
  const maxMs = CONFIG.ADMIN_SESSION_MAX_HOURS * 3600 * 1000;
  const sliding = now.getTime() + ttlMs;
  const ceiling = createdAt.getTime() + maxMs;
  return new Date(Math.min(sliding, ceiling));
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function sessionCookieOptions(): {
  httpOnly: boolean;
  sameSite: 'strict';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: CONFIG.IS_PRODUCTION,
    path: '/',
    maxAge: CONFIG.ADMIN_SESSION_TTL_HOURS * 3600,
  };
}

export async function createSession(ip: string | undefined): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await db.adminSession.create({
    data: {
      tokenHash: hashToken(token),
      ip: ip || null,
      expiresAt: sessionExpiry(new Date(), new Date()),
    },
  });
  return token;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Returns the live session row, or null when the token is missing/unknown/expired. */
export async function getSession(token: string | undefined) {
  if (!token) return null;
  const session = await db.adminSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return session;
}

/**
 * Guard-path check that also slides the session forward. Returns true (and
 * renews the row) only for a live session; expired/unknown tokens are never
 * resurrected. Called on every authenticated admin request.
 */
export async function renewSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const session = await db.adminSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session || session.expiresAt.getTime() <= Date.now()) return false;
  const nextExpiry = sessionExpiry(session.createdAt, new Date());
  if (nextExpiry.getTime() !== session.expiresAt.getTime()) {
    await db.adminSession.update({ where: { id: session.id }, data: { expiresAt: nextExpiry } });
  }
  return true;
}
