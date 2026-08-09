'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Login failed.');
        return;
      }
      router.push(json.role === 'operator' ? '/admin' : '/dashboard');
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container" style={{ maxWidth: 460 }}>
      <div className="card">
        <h2>Log in</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Logging in…' : 'Log in'}
          </button>
        </form>
      </div>
    </main>
  );
}
