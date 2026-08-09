// Live health probe against a tenant container's /health endpoint. Used by the
// operator console to surface containers that are marked `active` but are
// actually down or crash-looping (Docker `--restart unless-stopped` will keep a
// broken app bouncing, and the DB status never changes on its own).
export async function checkInstanceHealth(port: number): Promise<{
  healthy: boolean;
  latencyMs: number | null;
  error?: string;
}> {
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    return { healthy: res.ok, latencyMs: Date.now() - started };
  } catch {
    return { healthy: false, latencyMs: Date.now() - started, error: 'unreachable' };
  }
}
