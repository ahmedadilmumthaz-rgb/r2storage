import { customerUsage } from '@/lib/usage';
import { requireCustomer } from '@/lib/session';
import { ok, fail } from '@/lib/http';

export async function GET() {
  let customerId: string;
  try {
    customerId = await requireCustomer();
  } catch {
    return fail(401, 'Unauthorized');
  }
  const usage = await customerUsage(customerId);
  return ok({ usage });
}
