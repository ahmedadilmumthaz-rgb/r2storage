'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function InstanceControls({ instanceId, status }: { instanceId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function act(action: 'suspend' | 'resume' | 'delete') {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/instances/${instanceId}`, {
        method: action === 'delete' ? 'DELETE' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: action === 'delete' ? undefined : JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Action failed.');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {status === 'active' && (
          <button className="secondary" disabled={busy} onClick={() => act('suspend')}>
            Suspend
          </button>
        )}
        {status === 'suspended' && (
          <button className="secondary" disabled={busy} onClick={() => act('resume')}>
            Resume
          </button>
        )}
        <button className="danger" disabled={busy} onClick={() => act('delete')}>
          Delete instance
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

export function ProvisionForm() {
  const router = useRouter();
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Provisioning failed.');
        return;
      }
      setMessage('Instance provisioned.');
      router.refresh();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="prov-domain">Your domain</label>
        <input
          id="prov-domain"
          type="text"
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          required
        />
      </div>
      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Provisioning… (takes ~30s)' : 'Provision instance'}
      </button>
    </form>
  );
}

export function BillingCard({
  planId,
  planName,
  priceMonthlyCents,
  stripeStatus,
  billingConfigured,
}: {
  planId: string;
  planName: string;
  priceMonthlyCents: number;
  stripeStatus: string | null;
  billingConfigured: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const hasActiveSub = stripeStatus === 'active' || stripeStatus === 'trialing';

  async function go(endpoint: string, body?: Record<string, string>) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Billing request failed.');
        return;
      }
      window.location.href = json.url;
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  }

  const price = priceMonthlyCents > 0 ? `$${(priceMonthlyCents / 100).toFixed(0)}/mo` : 'Free';

  return (
    <div className="card">
      <h2>Plan &amp; billing</h2>
      <p className="muted">
        Current plan: <strong>{planName}</strong> · {price}
        {hasActiveSub && <span className="pill active" style={{ marginLeft: '0.6rem' }}>{stripeStatus}</span>}
      </p>
      {!billingConfigured ? (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Billing is coming soon — usage is metered and your instance keeps running.
        </p>
      ) : hasActiveSub ? (
        <button className="secondary" disabled={busy} onClick={() => go('/api/billing/portal')}>
          Manage billing
        </button>
      ) : planId === 'free' ? (
        <button className="primary" disabled={busy} onClick={() => go('/api/billing/checkout', { planId: 'pro' })}>
          Upgrade to Pro
        </button>
      ) : (
        <button className="secondary" disabled={busy} onClick={() => go('/api/billing/portal')}>
          Manage billing
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
