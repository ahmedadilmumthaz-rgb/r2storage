'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PLANS } from '@/lib/plans';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [planId, setPlanId] = useState('free');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, domain, planId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Signup failed.');
        return;
      }
      if (json.autoVerified) {
        setMessage('Account created. Provisioning your instance…');
        await new Promise((r) => setTimeout(r, 400));
        // Same flow the email link triggers: verify -> auto-login -> provision.
        await fetch(`/api/auth/verify?token=${encodeURIComponent(json.verifyToken)}`);
        await new Promise((r) => setTimeout(r, 800));
        router.push('/dashboard');
      } else {
        setMessage(json.message || 'Account created — check your email to verify.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <div className="card">
        <h2>Create your account</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="domain">Your domain (root domain, no subdomain)</label>
            <input
              id="domain"
              type="text"
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              required
            />
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: '-0.4rem' }}>
              Your instance will be reachable at cdn.<span className="mono" style={{ display: 'inline' }}>{domain || 'yourdomain.com'}</span>{' '}
              and panel.<span className="mono" style={{ display: 'inline' }}>{domain || 'yourdomain.com'}</span>.
            </p>
          </div>
          <div className="field">
            <label htmlFor="password">Password (min 10 characters)</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          </div>

          <label>Plan</label>
          <div className="plans">
            {PLANS.map((p) => (
              <div
                key={p.id}
                className={`plan ${planId === p.id ? 'selected' : ''}`}
                onClick={() => setPlanId(p.id)}
                role="button"
              >
                <strong>{p.name}</strong>
                <div className="price">${(p.priceMonthlyCents / 100).toFixed(p.priceMonthlyCents % 100 ? 2 : 0)}</div>
                <div className="desc">{p.description}</div>
              </div>
            ))}
          </div>

          {error && <p className="error">{error}</p>}
          {message && <p className="success">{message}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Sign up'}
          </button>
        </form>
      </div>
    </main>
  );
}
