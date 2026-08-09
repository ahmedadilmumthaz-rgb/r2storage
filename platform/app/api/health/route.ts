import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Liveness + DB reachability probe for systemd/load-balancer checks (mirrors
// the tenant backend's /health). Returns 200 only when a trivial query runs.
export async function GET() {
  try {
    await db.$queryRawUnsafe('SELECT 1');
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
