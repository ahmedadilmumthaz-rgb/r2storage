export async function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
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

export async function login(secret: string): Promise<boolean> {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  return res.ok;
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
