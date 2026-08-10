import { FastifyRequest } from 'fastify';
import { db } from '../db';

declare module 'fastify' {
  interface FastifyRequest {
    /** Auth source established by the admin guard: dashboard cookie vs x-admin-secret script. */
    adminActor?: 'session' | 'header';
  }
}

export type AuditActor = 'session' | 'header' | 'system';

/**
 * Append a row to the admin audit trail. Best-effort and never throws: a failed
 * audit write must not fail the action it is recording (same pattern as the
 * FailedLogin table). Call after the mutating operation succeeds.
 *
 * `target` is the subject of the action (bucket name, access-key id, ...);
 * `detail` is optional JSON context (permissions, filters, quota limits, ...).
 * `actor` defaults to the guard-established auth source; pass 'system' for
 * auth-lifecycle events (login/logout) that run before/outside the guard.
 */
export function auditLog(
  req: FastifyRequest,
  action: string,
  target?: string | null,
  detail?: Record<string, unknown> | null,
  actor?: AuditActor
): void {
  db.auditLog
    .create({
      data: {
        actor: actor ?? req.adminActor ?? 'header',
        ip: req.ip || 'unknown',
        userAgent: (req.headers['user-agent'] as string) || null,
        action,
        target: target || null,
        detail: detail ? JSON.stringify(detail) : null,
      },
    })
    .catch(() => {});
}
