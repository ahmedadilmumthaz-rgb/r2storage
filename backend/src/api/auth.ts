import { FastifyInstance, FastifyRequest } from 'fastify';
import { CONFIG } from '../config';
import { secretsEqual } from '../auth/secrets';
import { SESSION_COOKIE, createSession, destroySession, isValidSession, sessionCookieOptions } from '../auth/session';
import { isLockedOut, recordFailure, resetLockout } from '../auth/lockout';
import { db } from '../db';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Dashboard authentication. A successful login swaps the ADMIN_SECRET for a
 * random session token in an HttpOnly SameSite=Strict cookie; the token is
 * stored server-side hashed (SHA-256) in SQLite so sessions can be revoked
 * and expired. These three routes are exempt from the admin guard in
 * adminRoutes (login must not require auth; session/logout are harmless
 * unauthenticated).
 *
 * Login is also the brute-force target, so it is gated by a two-tier lockout
 * (per-IP + global, see auth/lockout.ts): a locked request gets 429 with a
 * Retry-After header BEFORE the secret is even compared, and failed attempts
 * answer after a fixed delay to slow guessing.
 */
export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/api/admin/login', async (req: FastifyRequest, reply) => {
    const { secret } = (req.body || {}) as { secret?: string };

    const locked = isLockedOut(req.ip);
    if (locked.locked) {
      reply.header('Retry-After', String(locked.retryAfterSec));
      return reply.status(429).send({ error: 'Too many failed login attempts. Try again later.' });
    }

    if (typeof secret !== 'string' || !secretsEqual(secret, CONFIG.ADMIN_SECRET)) {
      // Audit the failure, count it toward both lockout tiers, and answer after
      // a fixed delay (timing must not reveal whether the secret matched).
      db.failedLogin.create({
        data: { ip: req.ip || 'unknown', userAgent: (req.headers['user-agent'] as string) || null },
      }).catch(() => {});
      recordFailure(req.ip, 'both');
      await sleep(CONFIG.LOGIN_FAILURE_DELAY_MS);
      return reply.status(401).send({ error: 'Unauthorized. Invalid admin secret.' });
    }

    resetLockout(req.ip);
    const token = await createSession(req.ip);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
    return { ok: true };
  });

  fastify.post('/api/admin/logout', async (req: FastifyRequest, reply) => {
    await destroySession((req.cookies || {})[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  fastify.get('/api/admin/session', async (req: FastifyRequest) => {
    const token = (req.cookies || {})[SESSION_COOKIE];
    return { authenticated: await isValidSession(token) };
  });
}
