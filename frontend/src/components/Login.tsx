import React, { useState } from 'react';
import { Cloud, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { login } from '../api';

export const Login: React.FC<{ onAuthenticated: () => void }> = ({ onAuthenticated }) => {
  const [secret, setSecret] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret) return;
    setLoading(true);
    setError('');
    try {
      const status = await login(secret, totp.trim() || undefined);
      if (status === 200) {
        onAuthenticated();
      } else if (status === 429) {
        setError('Too many failed attempts — this IP is temporarily locked out.');
      } else {
        setError('Invalid admin secret or authenticator code.');
      }
    } catch {
      setError('Could not reach the server. Check that it is running.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="glass-panel p-8 rounded-2xl space-y-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-brand-600 to-amber-500 flex items-center justify-center shadow-lg shadow-brand-500/20">
              <Cloud className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-extrabold text-white">CloudStorage R2</h1>
              <p className="text-slate-400 text-sm mt-1">Admin access required</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" /> Admin Secret
              </label>
              <input
                type="password"
                placeholder="Enter the ADMIN_SECRET configured on the server"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                className="w-full bg-dark-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500 font-mono"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" /> Authenticator Code <span className="text-slate-500">(required if 2FA is enabled)</span>
              </label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code from your authenticator app"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                className="w-full bg-dark-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500 font-mono tracking-widest"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-rose-400 text-xs bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2.5">
                <Lock className="w-3.5 h-3.5" /> {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white font-medium rounded-xl shadow-lg shadow-brand-500/20 transition flex items-center justify-center gap-2 text-sm"
            >
              {loading ? 'Checking...' : 'Unlock Dashboard'}
            </button>
          </form>

          <p className="text-xs text-slate-500 text-center">
            Set the <span className="font-mono text-slate-400">ADMIN_SECRET</span> environment variable on your server to control access.
          </p>
        </div>
      </div>
    </div>
  );
};
