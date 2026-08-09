export type PlanDef = {
  id: string;
  name: string;
  description: string;
  priceMonthlyCents: number;
  storageBytesLimit: bigint;
  bandwidthBytesLimit: bigint;
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
