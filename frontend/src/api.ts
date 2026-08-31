export async function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  // Only advertise a JSON body when one is actually present. Fastify rejects a
  // request that declares Content-Type: application/json but sends zero bytes
  // (FST_ERR_CTP_EMPTY_JSON_BODY -> 400), which broke every body-less
  // DELETE (bucket/object/domain) issued through this helper.
  const hasBody = options.body !== undefined && options.body !== null && !isFormData;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('r2:unauthorized'));
  }
  return res;
}

/** Subscribe to session loss (401 from any admin endpoint). Returns an unsubscribe fn. */
export function onUnauthorized(cb: () => void): () => void {
  window.addEventListener('r2:unauthorized', cb);
  return () => window.removeEventListener('r2:unauthorized', cb);
}

export async function login(secret: string, totp?: string): Promise<number> {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, ...(totp ? { totp } : {}) }),
  });
  return res.status;
}

export async function logout(): Promise<void> {
  await fetch('/api/admin/logout', { method: 'POST' });
}

export async function getSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/session');
    const json = await res.json();
    return json.authenticated === true;
  } catch {
    return false;
  }
}
