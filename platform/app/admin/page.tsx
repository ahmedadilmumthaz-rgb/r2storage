'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type AdminRow = {
  id: string;
  domain: string;
  status: string;
  port: number;
  containerId: string | null;
  plan: string;
  createdAt: string;
  customer: { email: string; name: string };
  cfStatus: string | null;
  cfSslStatus: string | null;
  usage: { storageBytes: string; requests: number; bytesTransferred: string; at: string } | null;
};

function fmt(n: string): string {
  const v = Number(n);
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

export default function AdminPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [stats, setStats] = useState<{ customers: number; activeInstances: number; suspendedInstances: number; storageBytes: string } | null>(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [a, b] = await Promise.all([
        fetch('/api/admin/instances'),
        fetch('/api/admin/stats'),
      ]);
      if (a.status === 401 || b.status === 401) {
        router.push('/login');
        return;
      }
      setRows((await a.json()).instances);
      setStats((await b.json()));
    } catch {
      setError('Failed to load admin data.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [a, b] = await Promise.all([
          fetch('/api/admin/instances'),
          fetch('/api/admin/stats'),
        ]);
        if (cancelled) return;
        if (a.status === 401 || b.status === 401) {
          router.push('/login');
          return;
        }
        setRows((await a.json()).instances);
        setStats((await b.json()));
      } catch {
        if (!cancelled) setError('Failed to load admin data.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function act(id: string, action: 'suspend' | 'resume' | 'delete') {
    const res = await fetch(`/api/instances/${id}`, {
      method: action === 'delete' ? 'DELETE' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: action === 'delete' ? undefined : JSON.stringify({ action }),
    });
    if (res.ok) await load();
  }

  async function meter() {
    const res = await fetch('/api/meter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 401) {
      setError('Metering is key-guarded; trigger it via the timer or the METER_KEY header.');
      return;
    }
    await load();
  }

  return (
    <main className="container" style={{ maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>Operator console</h1>

      {stats && (
        <div className="grid-2">
          <div className="card">
            <h2>Customers</h2>
            <div style={{ fontSize: '2rem', fontWeight: 700 }}>{stats.customers}</div>
          </div>
          <div className="card">
            <h2>Instances</h2>
            <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>
              {stats.activeInstances} active
            </div>
            <div className="muted">
              {stats.suspendedInstances} suspended · {fmt(stats.storageBytes)} stored
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0 }}>Instances</h2>
          <button className="secondary" onClick={meter}>
            Poll usage now
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Port</th>
              <th>Plan</th>
              <th>Usage</th>
              <th>CF TLS</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><code className="mono" style={{ display: 'inline' }}>{r.domain}</code></td>
                <td>
                  {r.customer.name}
                  <div className="muted" style={{ fontSize: '0.8rem' }}>{r.customer.email}</div>
                </td>
                <td><span className={`pill ${r.status}`}>{r.status}</span></td>
                <td className="mono">{r.port}</td>
                <td>{r.plan}</td>
                <td>
                  {r.usage
                    ? `${fmt(r.usage.storageBytes)} · ${r.usage.requests} req`
                    : '—'}
                </td>
                <td>{r.cfSslStatus ?? r.cfStatus ?? '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                    {r.status === 'active' && (
                      <button className="secondary" style={{ padding: '0.3rem 0.6rem' }} onClick={() => act(r.id, 'suspend')}>
                        Suspend
                      </button>
                    )}
                    {r.status === 'suspended' && (
                      <button className="secondary" style={{ padding: '0.3rem 0.6rem' }} onClick={() => act(r.id, 'resume')}>
                        Resume
                      </button>
                    )}
                    {r.status !== 'deleted' && (
                      <button className="danger" style={{ padding: '0.3rem 0.6rem' }} onClick={() => act(r.id, 'delete')}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
