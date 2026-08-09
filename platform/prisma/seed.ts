import { PrismaClient } from '@prisma/client';
import { PLANS } from '../lib/plans';

const prisma = new PrismaClient();

async function main() {
  for (const p of PLANS) {
    await prisma.plan.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        description: p.description,
        priceMonthlyCents: p.priceMonthlyCents,
        storageBytesLimit: p.storageBytesLimit,
        bandwidthBytesLimit: p.bandwidthBytesLimit,
        stripeProductId: p.stripeProductId || null,
        stripePriceId: p.stripePriceId || null,
      },
      create: {
        id: p.id,
        name: p.name,
        description: p.description,
        priceMonthlyCents: p.priceMonthlyCents,
        storageBytesLimit: p.storageBytesLimit,
        bandwidthBytesLimit: p.bandwidthBytesLimit,
        stripeProductId: p.stripeProductId || null,
        stripePriceId: p.stripePriceId || null,
      },
    });
    console.log(`[seed] plan ${p.id}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
