import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from './db';
import { ENV } from './env';
import { encryptSecret, randomToken, decryptSecret } from './crypto';
import { createCustomHostname, deleteCustomHostname, getCustomHostname } from './cf';
import { writeMapFile, reloadNginx } from './nginx';

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileP('docker', args);
  return stdout.trim();
}

export function isValidDomain(d: string): boolean {
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d);
}

async function nextFreePort(): Promise<number> {
  // Deleted rows keep their (unique) port, so ALL instances count here — only
  // a physical row removal frees a port.
  const used = new Set((await db.instance.findMany({ select: { port: true } })).map((i) => i.port));
  for (let p = ENV.TENANT_PORT_MIN; p <= ENV.TENANT_PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('No tenant ports left — platform at capacity');
}

async function waitForHealth(port: number, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`tenant on :${port} did not become healthy within ${timeoutMs}ms`);
}

async function tenantApi(port: number, secret: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': secret, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`tenant API ${path} failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function runContainer(instanceId: string, domain: string, port: number, adminSecret: string, storageBytesLimit: number): Promise<string> {
  const vol = `${ENV.TENANT_STORAGE_BASE}/${instanceId}/data`;
  const name = `r2storage-${instanceId}`;

  await docker(['rm', '-f', name]).catch(() => {});
  await execFileP('mkdir', ['-p', vol]);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    await execFileP('chown', ['-R', '10001:10001', vol]).catch(() => {});
  }

  const id = await docker([
    'run', '-d',
    '--name', name,
    '--hostname', name,
    '--restart', 'unless-stopped',
    '--memory', '1g',
    '--cpus', '1',
    '--pids-limit', '256',
    '--read-only',
    '--tmpfs', '/tmp:size=128m',
    '-p', `127.0.0.1:${port}:4000`,
    '-v', `${vol}:/var/lib/r2storage`,
    '-e', 'PORT=4000',
    '-e', 'HOST=0.0.0.0',
    '-e', 'NODE_ENV=production',
    '-e', 'HOME=/tmp',
    '-e', 'npm_config_cache=/tmp/npm-cache',
    '-e', 'DATABASE_URL=file:/var/lib/r2storage/storage.db',
    '-e', 'STORAGE_DIR=/var/lib/r2storage/storage_blobs',
    '-e', `ADMIN_SECRET=${adminSecret}`,
    '-e', `BASE_DOMAIN=${domain}`,
    // Boot-time default quota; the authoritative value is pushed via PATCH
    // /api/admin/quota right after the container comes up.
    '-e', `STORAGE_QUOTA_BYTES=${storageBytesLimit}`,
    ENV.R2_IMAGE,
  ]);
  return id;
}

function ensureImage(): Promise<void> {
  return docker(['image', 'inspect', ENV.R2_IMAGE]).then(() => undefined);
}

// Provisions an instance end-to-end:
//  1. validate + pick port
//  2. docker run the tenant container (loopback port, volume, resource limits)
//  3. wait for /health, then create a default bucket + FULL initial access key
//  4. register *.domain as a Cloudflare SSL-for-SaaS custom hostname
//  5. write the nginx host map + reload
// Rolls everything back on failure.
export async function provisionInstance(customerId: string, domain: string, planId: string) {
  const normalized = domain.toLowerCase().trim();
  if (!isValidDomain(normalized)) {
    throw new Error('Invalid domain. Use a real root domain like example.com');
  }

  const dup = await db.instance.findFirst({ where: { domain: normalized, status: { not: 'deleted' } } });
  if (dup) throw new Error('That domain is already registered on the platform.');

  const perCustomer = await db.instance.count({ where: { customerId, status: { in: ['pending', 'active', 'suspended'] } } });
  if (perCustomer >= ENV.MAX_INSTANCES_PER_CUSTOMER) {
    throw new Error('You already have an active instance.');
  }
  const activeCount = await db.instance.count({ where: { status: { in: ['pending', 'active'] } } });
  if (activeCount >= ENV.MAX_ACTIVE_INSTANCES) {
    throw new Error('Platform is at capacity right now — try again in a few minutes.');
  }

  try {
    await ensureImage();
  } catch {
    throw new Error('Tenant image is not built on this host. Build it with: docker build -t r2storage -f backend/Dockerfile .');
  }

  const port = await nextFreePort();
  const adminSecret = randomToken(32);
  const plan = await db.plan.findUniqueOrThrow({ where: { id: planId } });
  const storageBytesLimit = Number(plan.storageBytesLimit);
  const instance = await db.instance.create({
    data: { customerId, domain: normalized, port, planId, status: 'pending', adminSecretEnc: encryptSecret(adminSecret) },
  });

  try {
    const containerId = await runContainer(instance.id, normalized, port, adminSecret, storageBytesLimit);
    await waitForHealth(port);

    await tenantApi(port, adminSecret, '/api/admin/buckets', { method: 'POST', body: JSON.stringify({ name: 'default' }) });
    // Push the plan's storage quota so the tenant enforces it (0 = unlimited).
    await tenantApi(port, adminSecret, '/api/admin/quota', { method: 'PATCH', body: JSON.stringify({ storageBytesLimit }) });
    const key = await tenantApi(port, adminSecret, '/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Initial key', permission: 'FULL' }),
    });

    let cfHostnameId: string | null = null;
    try {
      const ch = await createCustomHostname(`*.${normalized}`);
      cfHostnameId = ch.id;
    } catch (e) {
      console.error('[provision] Cloudflare custom hostname failed (continuing without edge TLS):', (e as Error).message);
    }

    await db.instance.update({
      where: { id: instance.id },
      data: {
        containerId,
        status: 'active',
        cfHostnameId,
        initialKeyIdEnc: encryptSecret(key.accessKeyId),
        initialKeySecretEnc: encryptSecret(key.secretAccessKey),
      },
    });

    await writeMapFile();
    await reloadNginx();

    return await db.instance.findUniqueOrThrow({
      where: { id: instance.id },
      include: { plan: true },
    });
  } catch (e) {
    await docker(['rm', '-f', `r2storage-${instance.id}`]).catch(() => {});
    // Hard-delete on failed provisioning: the row's unique domain/port must be
    // released so the customer can retry immediately.
    await db.instance.delete({ where: { id: instance.id } }).catch(() => {});
    throw e;
  }
}

export async function suspendInstance(id: string): Promise<void> {
  const inst = await db.instance.findUniqueOrThrow({ where: { id } });
  await docker(['stop', `r2storage-${inst.id}`]).catch(() => {});
  await db.instance.update({ where: { id }, data: { status: 'suspended' } });
  await writeMapFile();
  await reloadNginx();
}

export async function resumeInstance(id: string): Promise<void> {
  const inst = await db.instance.findUniqueOrThrow({ where: { id } });
  await docker(['start', `r2storage-${inst.id}`]).catch(() => {});
  await waitForHealth(inst.port);
  await db.instance.update({ where: { id }, data: { status: 'active' } });
  await writeMapFile();
  await reloadNginx();
}

export async function deleteInstance(id: string): Promise<void> {
  const inst = await db.instance.findUniqueOrThrow({ where: { id } });
  await docker(['rm', '-f', `r2storage-${inst.id}`]).catch(() => {});
  await execFileP('rm', ['-rf', `${ENV.TENANT_STORAGE_BASE}/${inst.id}`]).catch(() => {});
  if (inst.cfHostnameId) await deleteCustomHostname(inst.cfHostnameId).catch(() => {});
  await db.instance.update({ where: { id }, data: { status: 'deleted', containerId: null } });
  await writeMapFile();
  await reloadNginx();
}

export type InstancePublic = {
  id: string;
  domain: string;
  status: string;
  plan: string;
  createdAt: string;
  adminSecret?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  cfStatus?: string | null;
  cfSslStatus?: string | null;
};

export function instanceToPublic(inst: {
  id: string;
  domain: string;
  status: string;
  planId: string;
  createdAt: Date;
  adminSecretEnc: string;
  initialKeyIdEnc: string | null;
  initialKeySecretEnc: string | null;
  cfHostnameId: string | null;
}): InstancePublic {
  return {
    id: inst.id,
    domain: inst.domain,
    status: inst.status,
    plan: inst.planId,
    createdAt: inst.createdAt.toISOString(),
    adminSecret: decryptSecret(inst.adminSecretEnc),
    accessKeyId: inst.initialKeyIdEnc ? decryptSecret(inst.initialKeyIdEnc) : undefined,
    accessKeySecret: inst.initialKeySecretEnc ? decryptSecret(inst.initialKeySecretEnc) : undefined,
  };
}

export async function cfHostnameStatus(inst: { cfHostnameId: string | null }): Promise<{ status: string | null; sslStatus: string | null }> {
  if (!inst.cfHostnameId) return { status: null, sslStatus: null };
  try {
    const ch = await getCustomHostname(inst.cfHostnameId);
    return { status: ch.status, sslStatus: ch.ssl?.status ?? null };
  } catch {
    return { status: 'unknown', sslStatus: null };
  }
}
