import { db } from '@/lib/db';
import { requireCustomer, requireOperator } from '@/lib/session';
import { suspendInstance, resumeInstance, deleteInstance } from '@/lib/provision';
import { ok, fail, parseBody } from '@/lib/http';

async function guard(id: string): Promise<{ ok: boolean; status?: number; message?: string }> {
  try {
    const customerId = await requireCustomer();
    const inst = await db.instance.findFirst({ where: { id } });
    if (!inst) return { ok: false, status: 404, message: 'Instance not found' };
    if (inst.customerId !== customerId) return { ok: false, status: 403, message: 'Forbidden' };
    return { ok: true };
  } catch {
    return { ok: false, status: 401, message: 'Unauthorized' };
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await guard(id);
  if (!g.ok) return fail(g.status || 401, g.message || 'Unauthorized');

  const { action } = await parseBody<{ action?: string }>(req);
  try {
    if (action === 'suspend') {
      await suspendInstance(id);
      return ok({ ok: true, status: 'suspended' });
    }
    if (action === 'resume') {
      await resumeInstance(id);
      return ok({ ok: true, status: 'active' });
    }
    return fail(400, "Action must be 'suspend' or 'resume'.");
  } catch (e) {
    return fail(500, (e as Error).message);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Operator may delete any instance; customers only their own.
  try {
    await requireOperator();
  } catch {
    const g = await guard(id);
    if (!g.ok) return fail(g.status || 401, g.message || 'Unauthorized');
  }
  try {
    await deleteInstance(id);
    return ok({ ok: true, status: 'deleted' });
  } catch (e) {
    return fail(500, (e as Error).message);
  }
}
