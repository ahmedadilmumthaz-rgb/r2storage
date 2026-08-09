'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

export default function VerifyPage() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') || '';
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('Verifying your email…');

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`);
        const json = await res.json();
        if (!res.ok) {
          setState('error');
          setMessage(json.error || 'Verification failed.');
          return;
        }
        setMessage('Email verified — provisioning your instance…');
        setTimeout(() => router.push('/dashboard'), 1500);
      } catch {
        setState('error');
        setMessage('Network error during verification.');
      }
    })();
  }, [token, router]);

  if (!token) {
    return (
      <main className="container" style={{ maxWidth: 460 }}>
        <div className="card">
          <h2>Verify your email</h2>
          <p className="error">Missing verification token.</p>
          <button className="secondary" onClick={() => router.push('/signup')}>
            Back to signup
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="container" style={{ maxWidth: 460 }}>
      <div className="card">
        <h2>Verify your email</h2>
        <p className={state === 'error' ? 'error' : 'success'}>{message}</p>
        {state === 'error' && (
          <button className="secondary" onClick={() => router.push('/signup')}>
            Back to signup
          </button>
        )}
      </div>
    </main>
  );
}
