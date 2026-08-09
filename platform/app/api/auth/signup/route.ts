import { db } from '@/lib/db';
import { ENV } from '@/lib/env';
import { hashPassword } from '@/lib/password';
import { randomToken } from '@/lib/crypto';
import { sendMail, isSmtpConfigured } from '@/lib/smtp';
import { getPlan } from '@/lib/plans';
import { ok, fail, parseBody } from '@/lib/http';

export async function POST(req: Request) {
  const { name, email, password, planId, domain } = await parseBody<{
    name?: string;
    email?: string;
    password?: string;
    planId?: string;
    domain?: string;
  }>(req);

  if (!name || !email || !password) return fail(400, 'Name, email and password are required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'Invalid email address.');
  if (password.length < 10) return fail(400, 'Password must be at least 10 characters.');
  if (!domain) return fail(400, 'Your domain is required (e.g. example.com).');
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
    return fail(400, 'Invalid domain. Use a real root domain like example.com.');
  }
  const plan = getPlan(planId || 'free');
  if (!plan) return fail(400, 'Unknown plan.');

  const emailLower = email.toLowerCase().trim();
  const existing = await db.customer.findUnique({ where: { email: emailLower } });
  if (existing) return fail(409, 'An account with this email already exists.');

  const passwordHash = await hashPassword(password);
  const verifyToken = randomToken(24);

  await db.customer.create({
    data: {
      name: name.trim(),
      email: emailLower,
      passwordHash,
      planId: plan.id,
      requestedDomain: domain.toLowerCase().trim(),
      verifyToken,
    },
  });

  if (isSmtpConfigured()) {
    const link = `${ENV.PLATFORM_BASE_URL}/verify?token=${verifyToken}`;
    await sendMail(
      emailLower,
      'Verify your R2 Storage account',
      `<p>Hi ${name},</p><p>Confirm your email to activate your storage instance:</p><p><a href="${link}">${link}</a></p>`,
      `Confirm your email to activate your storage instance:\n${link}`
    );
    return ok({ message: 'Account created. Check your email to verify.' });
  }

  // SMTP not configured (dev): mark verified but KEEP the token so the signup
  // page can run the same /api/auth/verify flow as the email link would.
  await db.customer.update({
    where: { email: emailLower },
    data: { verifiedAt: new Date() },
  });
  return ok({ message: 'Account created and verified (SMTP not configured).', autoVerified: true, verifyToken });
}
