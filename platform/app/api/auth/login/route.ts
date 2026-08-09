import { db } from '@/lib/db';
import { ENV } from '@/lib/env';
import { verifyPassword } from '@/lib/password';
import { createSession } from '@/lib/session';
import { ok, fail, parseBody } from '@/lib/http';

export async function POST(req: Request) {
  const { email, password } = await parseBody<{ email?: string; password?: string }>(req);
  if (!email || !password) return fail(400, 'Email and password are required.');

  const emailLower = email.toLowerCase().trim();

  // Operator account (configured via env)
  if (ENV.OPERATOR_EMAIL && emailLower === ENV.OPERATOR_EMAIL.toLowerCase() && ENV.OPERATOR_PASSWORD_HASH) {
    if (await verifyPassword(password, ENV.OPERATOR_PASSWORD_HASH)) {
      await createSession(null, 'operator');
      return ok({ ok: true, role: 'operator' });
    }
    return fail(401, 'Invalid email or password.');
  }

  const customer = await db.customer.findUnique({ where: { email: emailLower } });
  if (!customer || !(await verifyPassword(password, customer.passwordHash))) {
    return fail(401, 'Invalid email or password.');
  }
  if (!customer.verifiedAt) return fail(403, 'Verify your email before logging in.');

  await createSession(customer.id, 'customer');
  return ok({ ok: true, role: 'customer' });
}
