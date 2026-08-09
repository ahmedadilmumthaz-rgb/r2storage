import { destroySession } from '@/lib/session';
import { ok } from '@/lib/http';

export async function POST() {
  await destroySession();
  return ok({ ok: true });
}
