import { FastifyInstance, FastifyRequest } from 'fastify';
import { CONFIG } from '../config';
import { secretsEqual } from '../auth/secrets';
import { SESSION_COOKIE, createSession, destroySession, isValidSession, sessionCookieOptions } from '../auth/session';

/**
 * Dashboard authentication. A successful login swaps the ADMIN_SECRET for a
 * random session token in an HttpOnly SameSite=Strict cookie; the token is
 * stored server-side hashed (SHA-256) in SQLite so sessions can be revoked
 * and expired. These three routes are exempt from the admin guard in
 * adminRoutes (login must not require auth; session/logout are harmless
 * unauthenticated).
 */
export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/api/admin/login', async (req: FastifyRequest, reply) => {
    const { secret } = (req.body || {}) as { secret?: string };
    if (typeof secret !== 'string' || !secretsEqual(secret, CONFIG.ADMIN_SECRET)) {
      return reply.status(401).send({ error: 'Unauthorized. Invalid admin secret.' });
    }
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
