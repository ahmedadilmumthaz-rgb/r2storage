import { db } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import { provisionInstance, instanceToPublic, cfHostnameStatus } from '@/lib/provision';
import { ok, fail, parseBody } from '@/lib/http';

async function currentCustomer() {
  try {
    return await requireCustomer();
  } catch {
    return null;
  }
}

async function listInstances(customerId: string) {
  const instances = await db.instance.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(
    instances.map(async (i) => {
      const cf = await cfHostnameStatus(i);
      return { ...instanceToPublic(i), cfStatus: cf.status, cfSslStatus: cf.sslStatus };
    })
  );
}

export async function GET() {
  const customerId = await currentCustomer();
  if (!customerId) return fail(401, 'Unauthorized');
  const instances = await listInstances(customerId);
  return ok({ instances });
}

export async function POST(req: Request) {
  const customerId = await currentCustomer();
  if (!customerId) return fail(401, 'Unauthorized');

  const { domain } = await parseBody<{ domain?: string }>(req);
  if (!domain) return fail(400, 'Domain is required.');

  try {
    const customer = await db.customer.findUnique({ where: { id: customerId } });
    const inst = await provisionInstance(customerId, domain, customer?.planId || 'free');
    return ok({ instance: instanceToPublic(inst) });
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}
