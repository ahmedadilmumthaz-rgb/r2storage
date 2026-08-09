import { ENV } from '@/lib/env';
import { meterAll } from '@/lib/usage';
import { ok, fail } from '@/lib/http';

// Run on a schedule (systemd timer or instrumentation interval). Guarded by a
// shared secret so it isn't callable publicly.
export async function POST(req: Request) {
  const key = req.headers.get('x-meter-key');
  if (!ENV.METER_KEY || key !== ENV.METER_KEY) return fail(401, 'Unauthorized');
  const n = await meterAll();
  return ok({ ok: true, polled: n });
}
