export type PlanDef = {
  id: string;
  name: string;
  description: string;
  priceMonthlyCents: number;
  storageBytesLimit: bigint;
  bandwidthBytesLimit: bigint;
  // Stripe product/price ids. Leave empty until you've created matching products
  // on your Stripe account; checkout then reports "billing not configured" and
  // the platform keeps running metering-only.
  stripeProductId?: string;
  stripePriceId?: string;
};

export const PLANS: PlanDef[] = [
  {
    id: 'free',
    name: 'Free',
    description: '5 GB storage, 50 GB monthly transfer',
    priceMonthlyCents: 0,
    storageBytesLimit: 5n * 1024n ** 3n,
    bandwidthBytesLimit: 50n * 1024n ** 3n,
  },
  {
    id: 'pro',
    name: 'Pro',
    description: '100 GB storage, 1 TB monthly transfer',
    priceMonthlyCents: 1000,
    storageBytesLimit: 100n * 1024n ** 3n,
    bandwidthBytesLimit: 1024n ** 4n,
    // e.g. 'price_1...' — set after creating the subscription price in Stripe.
    stripePriceId: process.env.STRIPE_PRICE_PRO || '',
  },
];

export function getPlan(id: string): PlanDef | undefined {
  return PLANS.find((p) => p.id === id);
}

export function publicPlan(p: PlanDef) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    priceMonthlyCents: p.priceMonthlyCents,
  };
}
