import { isStripeConfigured, verifyWebhook, handleWebhookEvent } from '@/lib/stripe';
import { ok, fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

// Stripe webhook endpoint. Signature-verified via STRIPE_WEBHOOK_SECRET; the
// events drive plan changes + tenant quota sync.
export async function POST(req: Request) {
  if (!isStripeConfigured()) return fail(501, 'Billing is not configured.');

  const signature = req.headers.get('stripe-signature');
  if (!signature) return fail(400, 'Missing stripe-signature header.');
  const rawBody = await req.text();
  if (!rawBody) return fail(400, 'Empty body.');

  let event;
  try {
    event = await verifyWebhook(rawBody, signature);
  } catch (e) {
    return fail(400, `Invalid signature: ${(e as Error).message}`);
  }

  try {
    await handleWebhookEvent(event);
    return ok({ received: true });
  } catch (e) {
    console.error('[billing] webhook handling failed:', (e as Error).message);
    return fail(500, 'Webhook handling failed.');
  }
}
