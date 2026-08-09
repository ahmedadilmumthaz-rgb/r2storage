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
