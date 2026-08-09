import React, { useEffect, useState } from 'react';
import { Key, Plus, Trash2, Copy, Check, Shield } from 'lucide-react';
import { adminFetch } from '../api';

interface AccessKey {
  id: string;
  accessKeyId: string;
  secretAccessKey: string;
  name: string;
  permission: string;
  bucketFilter?: string;
  createdAt: string;
}

export const AccessKeysTab: React.FC = () => {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [permission, setPermission] = useState('FULL');
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<AccessKey | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      const res = await adminFetch('/api/admin/keys');
      const json = await res.json();
      setKeys(json);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await adminFetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: keyName || 'API Key', permission }),
      });
      const json = await res.json();
      if (res.ok) {
        setNewlyCreatedKey(json);
        setShowModal(false);
        setKeyName('');
        fetchKeys();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleRevokeKey = async (id: string) => {
    if (!confirm('Revoke this API Key? Client applications using this key will lose access.')) return;
    try {
      await adminFetch(`/api/admin/keys/${id}`, { method: 'DELETE' });
      fetchKeys();
    } catch (err) {
      console.error(err);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(label);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">API & Access Keys</h2>
          <p className="text-slate-400 text-sm">Issue AWS S3 compatible Access Key and Secret Key pairs</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-xl shadow-lg shadow-brand-500/20 transition flex items-center gap-2 text-sm"
        >
          <Plus className="w-4 h-4" /> Issue New API Key
        </button>
      </div>

      <div className="glass-panel p-6 rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase font-medium">
                <th className="pb-3 px-2">Key Name</th>
                <th className="pb-3 px-2">Access Key ID</th>
                <th className="pb-3 px-2">Permissions</th>
                <th className="pb-3 px-2">Created</th>
                <th className="pb-3 px-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {keys.map((k) => (
                <tr key={k.id} className="hover:bg-slate-800/30 transition">
                  <td className="py-3 px-2 font-medium text-white flex items-center gap-2">
                    <Key className="w-4 h-4 text-emerald-400" />
                    {k.name}
                  </td>
                  <td className="py-3 px-2 font-mono text-xs text-slate-300">{k.accessKeyId}</td>
                  <td className="py-3 px-2">
                    <span className="px-2 py-0.5 rounded text-xs font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/20">
                      {k.permission}
                    </span>
                  </td>
                  <td className="py-3 px-2 text-slate-400 text-xs">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td className="py-3 px-2 text-right">
                    <button
                      onClick={() => handleRevokeKey(k.id)}
                      className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}

              {keys.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-slate-500 text-sm">
                    No API keys issued yet. Click "Issue New API Key" above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Newly Created Key Modal */}
      {newlyCreatedKey && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-lg p-6 rounded-2xl space-y-6 border-l-4 border-l-emerald-500">
            <div className="flex items-center gap-3">
              <Shield className="w-6 h-6 text-emerald-400" />
              <div>
                <h3 className="text-lg font-bold text-white">API Key Issued Successfully</h3>
                <p className="text-xs text-amber-400">Save the Secret Key now! It will not be shown again.</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-400">Access Key ID</label>
                <div className="flex items-center justify-between p-3 bg-dark-900 border border-slate-800 rounded-xl font-mono text-xs text-slate-200">
                  <span>{newlyCreatedKey.accessKeyId}</span>
                  <button
                    onClick={() => copyToClipboard(newlyCreatedKey.accessKeyId, 'id')}
                    className="text-brand-500 hover:text-brand-400"
                  >
                    {copiedKey === 'id' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-400">Secret Access Key</label>
                <div className="flex items-center justify-between p-3 bg-dark-900 border border-slate-800 rounded-xl font-mono text-xs text-emerald-400">
                  <span>{newlyCreatedKey.secretAccessKey}</span>
                  <button
                    onClick={() => copyToClipboard(newlyCreatedKey.secretAccessKey, 'secret')}
                    className="text-emerald-500 hover:text-emerald-400"
                  >
                    {copiedKey === 'secret' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setNewlyCreatedKey(null)}
                className="px-4 py-2 bg-brand-500 text-white rounded-xl text-sm font-medium"
              >
                I Have Saved My Keys
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Key Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl space-y-6">
            <h3 className="text-xl font-bold text-white">Issue API Access Key</h3>
            <form onSubmit={handleCreateKey} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Key Name / Identifier</label>
                <input
                  type="text"
                  placeholder="e.g. Production Server Key"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  className="w-full bg-dark-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Permissions</label>
                <select
                  value={permission}
                  onChange={(e) => setPermission(e.target.value)}
                  className="w-full bg-dark-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500"
                >
                  <option value="FULL">Full Access (Read + Write + Delete)</option>
                  <option value="READ_ONLY">Read Only Access</option>
                  <option value="WRITE_ONLY">Write Only Access</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-slate-400 hover:text-white text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-xl shadow-lg shadow-brand-500/20"
                >
                  Issue Key
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
