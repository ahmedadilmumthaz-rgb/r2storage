import { db } from './db';
import { decryptSecret } from './crypto';

async function fetchUsage(port: number, secret: string, since?: string) {
  const url = `http://127.0.0.1:${port}/api/admin/usage${since ? `?since=${encodeURIComponent(since)}` : ''}`;
  const res = await fetch(url, {
    headers: { 'X-Admin-Secret': secret },
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`usage poll on :${port} failed: ${res.status} ${JSON.stringify(body)}`);
  return body as { storageBytes?: number; requests?: number; bytesTransferred?: number };
}

// Polls one active instance's /api/admin/usage (incremental since the last
// snapshot) and stores a UsageSnapshot row.
export async function pollInstance(id: string): Promise<void> {
  const inst = await db.instance.findUniqueOrThrow({ where: { id } });
  const last = await db.usageSnapshot.findFirst({
    where: { instanceId: id },
    orderBy: { at: 'desc' },
  });
  const since = last ? last.at.toISOString() : undefined;
  const usage = await fetchUsage(inst.port, decryptSecret(inst.adminSecretEnc), since);
  await db.usageSnapshot.create({
    data: {
      instanceId: id,
      storageBytes: BigInt(usage.storageBytes || 0),
      requests: usage.requests || 0,
      bytesTransferred: BigInt(usage.bytesTransferred || 0),
    },
  });
}

export async function meterAll(): Promise<number> {
  const instances = await db.instance.findMany({ where: { status: 'active' } });
  let ok = 0;
  for (const inst of instances) {
    try {
      await pollInstance(inst.id);
      ok++;
    } catch (e) {
      console.error(`[meter] instance ${inst.id} failed:`, (e as Error).message);
    }
  }
  return ok;
}

// Latest snapshot + plan limits for a customer's dashboard progress bars.
export async function customerUsage(customerId: string) {
  const inst = await db.instance.findFirst({
    where: { customerId, status: { in: ['pending', 'active', 'suspended'] } },
    include: { plan: true },
  });
  if (!inst) return null;
  const snap = await db.usageSnapshot.findFirst({
    where: { instanceId: inst.id },
    orderBy: { at: 'desc' },
  });
  return {
    instanceId: inst.id,
    status: inst.status,
    planId: inst.planId,
    planName: inst.plan.name,
    storageBytesLimit: inst.plan.storageBytesLimit.toString(),
    bandwidthBytesLimit: inst.plan.bandwidthBytesLimit.toString(),
    storageBytes: snap ? snap.storageBytes.toString() : '0',
    requests: snap ? snap.requests : 0,
    bytesTransferred: snap ? snap.bytesTransferred.toString() : '0',
    lastPolledAt: snap ? snap.at.toISOString() : null,
  };
}
