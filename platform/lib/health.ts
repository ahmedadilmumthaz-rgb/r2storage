// Live health probe against a tenant container's /health endpoint plus its
// /api/admin/quota readout. Used by the operator console to surface containers
// that are marked `active` but are actually down or crash-looping (Docker
// `--restart unless-stopped` will keep a broken app bouncing, and the DB status
// never changes on its own).
export async function checkInstanceHealth(
  port: number,
  secret: string
): Promise<{
  healthy: boolean;
  latencyMs: number | null;
  quota: { storageBytesLimit: number; storageBytes: number } | null;
  error?: string;
}> {
  const started = Date.now();
  const headers = { 'X-Admin-Secret': secret };
  try {
    const [healthRes, quotaRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) }),
      fetch(`http://127.0.0.1:${port}/api/admin/quota`, {
        headers,
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    const quota = quotaRes.ok ? await quotaRes.json().catch(() => null) : null;
    return { healthy: healthRes.ok, latencyMs: Date.now() - started, quota };
  } catch {
    return { healthy: false, latencyMs: Date.now() - started, quota: null, error: 'unreachable' };
  }
}
