import crypto from 'crypto';
import { db } from '../db';
import { CONFIG } from '../config';

export const SESSION_COOKIE = 'r2_admin_sid';

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
      expiresAt: new Date(Date.now() + CONFIG.ADMIN_SESSION_TTL_HOURS * 3600 * 1000),
    },
  });
  return token;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const session = await db.adminSession.findUnique({ where: { tokenHash: hashToken(token) } });
  return !!session && session.expiresAt.getTime() > Date.now();
}
