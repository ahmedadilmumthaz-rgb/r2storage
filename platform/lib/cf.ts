import { ENV } from './env';

const CF_API = 'https://api.cloudflare.com/client/v4';

export type CustomHostname = {
  id: string;
  hostname: string;
  status: string; // pending | active | moved | deleted | provisioning_failed
  ssl: {
    status: string; // pending_validation | pending_deployment | active | error | ...
    validation_errors?: unknown[];
    certificate_authority?: string;
  } | null;
};

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!ENV.CF_API_TOKEN || !ENV.CF_ZONE_ID) {
    throw new Error('Cloudflare not configured: set CF_API_TOKEN and CF_ZONE_ID');
  }
  const res = await fetch(`${CF_API}/zones/${ENV.CF_ZONE_ID}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ENV.CF_API_TOKEN}`,
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as { success: boolean; errors?: unknown[]; result?: T } | null;
  if (!res.ok || !body || body.success === false) {
    throw new Error(`Cloudflare API error ${res.status}: ${JSON.stringify(body?.errors || body)}`);
  }
  return body.result as T;
}

export function isCloudflareConfigured(): boolean {
  return !!(ENV.CF_API_TOKEN && ENV.CF_ZONE_ID);
}

// Registers a wildcard custom hostname (*.customer-domain) on the platform zone
// so Cloudflare's SSL for SaaS terminates edge TLS for every subdomain the
// customer uses (cdn./panel./<bucket>.) and proxies it to the fallback origin.
export async function createCustomHostname(hostname: string): Promise<CustomHostname> {
  return cf<CustomHostname>('/custom_hostnames', {
    method: 'POST',
    body: JSON.stringify({
      hostname,
      ssl: {
        method: 'cname',
        type: 'dv',
        settings: { min_tls_version: '1.2' },
      },
    }),
  });
}

export async function getCustomHostname(id: string): Promise<CustomHostname> {
  return cf<CustomHostname>(`/custom_hostnames/${id}`);
}

export async function listCustomHostnames(hostname?: string): Promise<CustomHostname[]> {
  const qs = hostname ? `?hostname=${encodeURIComponent(hostname)}` : '';
  return cf<CustomHostname[]>(`/custom_hostnames${qs}`);
}

export async function deleteCustomHostname(id: string): Promise<void> {
  await cf<unknown>(`/custom_hostnames/${id}`, { method: 'DELETE' });
}
