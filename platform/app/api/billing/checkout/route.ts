import { db } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import { isStripeConfigured, createCheckoutSession } from '@/lib/stripe';
import { getPlan } from '@/lib/plans';
import { ok, fail, parseBody } from '@/lib/http';

// Creates a subscription checkout session for a paid plan. Returns the hosted
// Stripe URL; the browser redirects to it. 501 when billing is not configured.
export async function POST(req: Request) {
  let customerId: string;
  try {
    customerId = await requireCustomer();
  } catch {
    return fail(401, 'Unauthorized');
  }
  if (!isStripeConfigured()) return fail(501, 'Billing is not configured.');

  const { planId } = await parseBody<{ planId?: string }>(req);
  const plan = getPlan(planId || '');
  if (!plan) return fail(400, 'Unknown plan.');
  if (plan.priceMonthlyCents <= 0) return fail(400, 'This plan does not require billing.');

  const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
  // An existing subscription should be managed via the billing portal, not a
  // second checkout.
  if (customer.stripeSubscriptionId && customer.stripeSubscriptionStatus === 'active') {
    return fail(409, 'You already have an active subscription — manage it from the dashboard.');
  }

  try {
    const url = await createCheckoutSession(customer, plan.id);
    return ok({ url });
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}
