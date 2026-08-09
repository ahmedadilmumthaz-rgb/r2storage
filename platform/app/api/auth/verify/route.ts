import { db } from '@/lib/db';
import { createSession } from '@/lib/session';
import { provisionInstance, instanceToPublic } from '@/lib/provision';
import { sendMail, isSmtpConfigured } from '@/lib/smtp';
import { ENV } from '@/lib/env';
import { ok, fail } from '@/lib/http';

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token');
  if (!token) return fail(400, 'Missing token.');

  const customer = await db.customer.findUnique({ where: { verifyToken: token } });
  if (!customer) return fail(400, 'Invalid or expired token.');

  await db.customer.update({
    where: { id: customer.id },
    data: { verifiedAt: new Date(), verifyToken: null },
  });

  // Auto-login so the dashboard is reachable right after verification.
  await createSession(customer.id, 'customer');

  // Provision the requested domain (best-effort; the dashboard can retry).
  let instanceProvisioned = false;
  let instanceId: string | null = null;
  let provisionError: string | null = null;
  if (customer.requestedDomain) {
    const hasInstance = await db.instance.findFirst({
      where: { customerId: customer.id, status: { in: ['pending', 'active', 'suspended'] } },
    });
    if (!hasInstance) {
      try {
        const inst = await provisionInstance(customer.id, customer.requestedDomain, customer.planId);
        instanceProvisioned = true;
        instanceId = inst.id;
        await sendWelcomeEmail(customer, inst);
      } catch (e) {
        provisionError = (e as Error).message;
      }
    }
  }

  return ok({ ok: true, instanceProvisioned, instanceId, provisionError });
}

async function sendWelcomeEmail(
  customer: { name: string; email: string },
  inst: Awaited<ReturnType<typeof provisionInstance>>
): Promise<void> {
  if (!isSmtpConfigured()) return; // credentials are shown on the dashboard instead
  const pub = instanceToPublic(inst);
  const origin = ENV.CF_FALLBACK_ORIGIN;
  const dashboard = `${ENV.PLATFORM_BASE_URL}/dashboard`;
  await sendMail(
    customer.email,
    'Your R2 Storage instance is ready',
    `<p>Hi ${customer.name},</p>
     <p>Your instance for <strong>${pub.domain}</strong> is live. Keep this email — it contains your credentials:</p>
     <ul>
       <li>Admin secret: <code>${pub.adminSecret}</code> (logs into your panel)</li>
       <li>Access key ID: <code>${pub.accessKeyId}</code></li>
       <li>Secret access key: <code>${pub.accessKeySecret}</code></li>
     </ul>
     <p>Point your domain at us (two CNAME records):</p>
     <ul>
       <li><code>cdn</code> → <code>${origin}</code></li>
       <li><code>panel</code> → <code>${origin}</code></li>
     </ul>
     <p>Dashboard: <a href="${dashboard}">${dashboard}</a></p>`,
    `Your instance for ${pub.domain} is live.\nAdmin secret: ${pub.adminSecret}\nAccess key ID: ${pub.accessKeyId}\nSecret access key: ${pub.accessKeySecret}\n\nPoint your domain at us (CNAME):\n  cdn   -> ${origin}\n  panel -> ${origin}\nDashboard: ${dashboard}`
  );
}
