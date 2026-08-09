import { getSession } from '@/lib/session';
import { ok } from '@/lib/http';

export async function GET() {
  const s = await getSession();
  return ok({ authenticated: !!s, role: s?.role ?? null });
}
