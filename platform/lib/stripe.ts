import Stripe from 'stripe';
import { ENV } from './env';
import { db } from './db';
import { PLANS, getPlan } from './plans';
import { applyPlanToInstance } from './provision';

let _stripe: Stripe | null | undefined;
function stripe(): Stripe | null {
  if (_stripe === undefined) {
    _stripe = ENV.STRIPE_SECRET_KEY ? new Stripe(ENV.STRIPE_SECRET_KEY) : null;
  }
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return Boolean(stripe() && ENV.STRIPE_WEBHOOK_SECRET);
}

export function planForPrice(priceId: string): string {
  return PLANS.find((p) => p.stripePriceId === priceId)?.id || 'free';
}

export async function createOrGetStripeCustomer(
  customer: { id: string; email: string; name: string }
): Promise<string> {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured.');
  if (customer.id) {
    const existing = await db.customer.findUnique({ where: { id: customer.id } });
    if (existing?.stripeCustomerId) return existing.stripeCustomerId;
  }
  const sc = await s.customers.create({
    email: customer.email,
    name: customer.name,
    metadata: { platformCustomerId: customer.id },
  });
  await db.customer.update({ where: { id: customer.id }, data: { stripeCustomerId: sc.id } });
  return sc.id;
}

// Creates a subscription checkout for the given plan. Only used when the
// customer has no active subscription (plan changes go through the billing
// portal). Returns the hosted checkout URL.
export async function createCheckoutSession(
  customer: { id: string; email: string; name: string },
  planId: string
): Promise<string> {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured.');
  const plan = getPlan(planId);
  if (!plan) throw new Error('Unknown plan.');
  if (!plan.stripePriceId) throw new Error(`No Stripe price configured for plan "${planId}".`);
  if (plan.priceMonthlyCents <= 0) throw new Error('This plan does not require billing.');

  const stripeCustomerId = await createOrGetStripeCustomer(customer);
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    metadata: { planId, platformCustomerId: customer.id },
    subscription_data: { metadata: { planId, platformCustomerId: customer.id } },
    success_url: `${ENV.PLATFORM_BASE_URL}/dashboard?checkout=success`,
    cancel_url: `${ENV.PLATFORM_BASE_URL}/dashboard?checkout=cancel`,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL.');
  return session.url;
}

// Customer portal (manage/cancel subscription, update payment method).
export async function createPortalSession(stripeCustomerId: string): Promise<string> {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured.');
  const session = await s.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${ENV.PLATFORM_BASE_URL}/dashboard`,
  });
  return session.url;
}

export async function verifyWebhook(rawBody: string, signature: string): Promise<Stripe.Event> {
  const s = stripe();
  if (!s || !ENV.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe is not configured.');
  return s.webhooks.constructEvent(rawBody, signature, ENV.STRIPE_WEBHOOK_SECRET);
}

// Applies a subscription/price change to the local customer + tenant quota.
// `subscriptionId` and `status` are optional (a plain plan switch or cancelled
// state); planId falls back to the price's plan.
export async function syncSubscription(
  stripeCustomerId: string,
  opts: {
    planId?: string;
    priceId?: string;
    subscriptionId?: string | null;
    status?: string | null;
  }
): Promise<void> {
  const customer = await db.customer.findUnique({ where: { stripeCustomerId } });
  if (!customer) return; // webhook for a customer we don't track — ignore

  const planId = opts.planId || (opts.priceId ? planForPrice(opts.priceId) : customer.planId);
  const subscriptionId = opts.subscriptionId ?? customer.stripeSubscriptionId;
  const status = opts.status ?? customer.stripeSubscriptionStatus;
  const priceId = opts.priceId ?? customer.stripePriceId;

  await db.customer.update({
    where: { id: customer.id },
    data: {
      planId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionStatus: status,
      stripePriceId: priceId,
    },
  });
  await applyPlanToInstance(customer.id);
}

// Entry point for webhook events.
export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (typeof session.customer !== 'string' || !session.subscription) return;
      const planId = session.metadata?.planId;
      await syncSubscription(session.customer, {
        planId: planId && getPlan(planId) ? planId : undefined,
        subscriptionId: session.subscription as string,
        status: 'active',
      });
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      if (typeof sub.customer !== 'string') return;
      const priceId = sub.items.data[0]?.price.id;
      const status = sub.status; // active | trialing | past_due | canceled | ...
      await syncSubscription(sub.customer, { priceId, subscriptionId: sub.id, status });
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      if (typeof sub.customer !== 'string') return;
      await syncSubscription(sub.customer, {
        planId: 'free',
        subscriptionId: null,
        status: 'canceled',
      });
      break;
    }
    default:
      break;
  }
}
