import { db } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import { isStripeConfigured, createPortalSession } from '@/lib/stripe';
import { ok, fail } from '@/lib/http';

// Opens the Stripe customer portal (manage/cancel subscription, payment
// method). 501 when billing is not configured.
export async function POST() {
  let customerId: string;
  try {
    customerId = await requireCustomer();
  } catch {
    return fail(401, 'Unauthorized');
  }
  if (!isStripeConfigured()) return fail(501, 'Billing is not configured.');

  const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
  if (!customer.stripeCustomerId) return fail(400, 'No Stripe customer on file.');

  try {
    const url = await createPortalSession(customer.stripeCustomerId);
    return ok({ url });
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}
