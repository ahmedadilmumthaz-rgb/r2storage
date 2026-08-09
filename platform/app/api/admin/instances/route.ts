import { db } from '@/lib/db';
import { requireOperator } from '@/lib/session';
import { cfHostnameStatus } from '@/lib/provision';
import { ok, fail } from '@/lib/http';

export async function GET() {
  try {
    await requireOperator();
  } catch {
    return fail(401, 'Unauthorized');
  }
  const instances = await db.instance.findMany({
    orderBy: { createdAt: 'desc' },
    include: { customer: { select: { email: true, name: true, planId: true } }, plan: true },
  });
  const rows = await Promise.all(
    instances.map(async (i) => {
      const cf = await cfHostnameStatus(i);
      const latest = await db.usageSnapshot.findFirst({
        where: { instanceId: i.id },
        orderBy: { at: 'desc' },
      });
      return {
        id: i.id,
        domain: i.domain,
        status: i.status,
        port: i.port,
        containerId: i.containerId,
        plan: i.planId,
        createdAt: i.createdAt.toISOString(),
        customer: i.customer,
        cfStatus: cf.status,
        cfSslStatus: cf.sslStatus,
        usage: latest
          ? {
              storageBytes: latest.storageBytes.toString(),
              requests: latest.requests,
              bytesTransferred: latest.bytesTransferred.toString(),
              at: latest.at.toISOString(),
            }
          : null,
      };
    })
  );
  return ok({ instances: rows });
}
