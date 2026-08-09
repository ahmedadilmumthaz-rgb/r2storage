import { cookies } from 'next/headers';
import { db } from './db';
import { ENV } from './env';
import { randomToken, sha256 } from './crypto';

const COOKIE = 'r2p_sid';

export type SessionInfo = { role: string; customerId: string | null };

export async function createSession(customerId: string | null, role: string): Promise<void> {
  const token = randomToken(32);
  await db.session.create({
    data: {
      tokenHash: sha256(token),
      customerId,
      role,
      expiresAt: new Date(Date.now() + ENV.SESSION_TTL_HOURS * 3600_000),
    },
  });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: ENV.NODE_ENV === 'production',
    path: '/',
    maxAge: ENV.SESSION_TTL_HOURS * 3600,
  });
}

export async function destroySession(): Promise<void> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (token) {
    await db.session.deleteMany({ where: { tokenHash: sha256(token) } }).catch(() => {});
  }
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) } });
  if (!s || s.expiresAt < new Date()) return null;
  return { role: s.role, customerId: s.customerId };
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
  }
}

export async function requireCustomer(): Promise<string> {
  const s = await getSession();
  if (!s || s.role !== 'customer' || !s.customerId) throw new UnauthorizedError();
  return s.customerId;
}

export async function requireOperator(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s || s.role !== 'operator') throw new UnauthorizedError();
  return s;
}
