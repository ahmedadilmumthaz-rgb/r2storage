import { db } from '@/lib/db';
import { requireOperator } from '@/lib/session';
import { ok, fail } from '@/lib/http';

export async function GET() {
  try {
    await requireOperator();
  } catch {
    return fail(401, 'Unauthorized');
  }
  const [customers, activeInstances, suspendedInstances, totalStorage] = await Promise.all([
    db.customer.count(),
    db.instance.count({ where: { status: 'active' } }),
    db.instance.count({ where: { status: 'suspended' } }),
    db.usageSnapshot.findMany({ select: { storageBytes: true }, orderBy: { at: 'desc' }, take: 1 }),
  ]);
  const latestStorage = totalStorage[0]?.storageBytes ?? 0n;
  return ok({
    customers,
    activeInstances,
    suspendedInstances,
    storageBytes: latestStorage.toString(),
  });
}
