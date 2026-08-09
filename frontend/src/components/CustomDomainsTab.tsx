import React, { useEffect, useState } from 'react';
import { Globe, Plus, Trash2, CheckCircle, ShieldAlert, ArrowRight } from 'lucide-react';
import { adminFetch } from '../api';

interface CustomDomain {
  id: string;
  domain: string;
  bucketName: string;
  sslStatus: string;
  createdAt: string;
}

interface Bucket {
  id: string;
  name: string;
}

export const CustomDomainsTab: React.FC = () => {
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [selectedBucket, setSelectedBucket] = useState('');

  const fetchDomains = async () => {
    try {
      const res = await adminFetch('/api/admin/domains');
      const json = await res.json();
      setDomains(json);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchBuckets = async () => {
    try {
      const res = await adminFetch('/api/admin/buckets');
      const json = await res.json();
      setBuckets(json);
      if (json.length > 0) setSelectedBucket(json[0].name);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchDomains();
    fetchBuckets();
  }, []);

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domainInput || !selectedBucket) return;

    try {
      const res = await adminFetch('/api/admin/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainInput, bucketName: selectedBucket }),
      });
      if (res.ok) {
        setDomainInput('');
        setShowModal(false);
        fetchDomains();
      } else {
        const errorData = await res.json();
        alert(errorData.error || 'Failed to add custom domain');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteDomain = async (id: string) => {
    if (!confirm('Remove this custom domain mapping?')) return;
    try {
      await adminFetch(`/api/admin/domains/${id}`, { method: 'DELETE' });
      fetchDomains();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Custom Domains & SSL</h2>
          <p className="text-slate-400 text-sm">Map custom domain names to storage buckets with automated HTTPS</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-xl shadow-lg shadow-brand-500/20 transition flex items-center gap-2 text-sm"
        >
          <Plus className="w-4 h-4" /> Add Custom Domain
        </button>
      </div>

      {/* DNS Setup Helper Box */}
      <div className="glass-panel p-5 rounded-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-l-4 border-l-purple-500">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Globe className="w-4 h-4 text-purple-400" /> DNS CNAME Configuration
          </h3>
          <p className="text-xs text-slate-400">
            To point a domain (e.g. <span className="font-mono text-purple-300">cdn.yourcompany.com</span>) to your VPS, add a DNS CNAME record pointing to your VPS IP or primary server domain.
          </p>
        </div>
      </div>

      {/* Domain List Table */}
      <div className="glass-panel p-6 rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase font-medium">
                <th className="pb-3 px-2">Domain Name</th>
                <th className="pb-3 px-2">Mapped Bucket</th>
                <th className="pb-3 px-2">SSL Status</th>
                <th className="pb-3 px-2">Added Date</th>
                <th className="pb-3 px-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {domains.map((d) => (
                <tr key={d.id} className="hover:bg-slate-800/30 transition">
                  <td className="py-3 px-2 font-mono text-sm font-semibold text-white flex items-center gap-2">
                    <Globe className="w-4 h-4 text-purple-400" />
                    {d.domain}
                  </td>
                  <td className="py-3 px-2 font-mono text-xs text-slate-300">
                    <span className="px-2 py-0.5 rounded bg-dark-800 border border-slate-700">
                      {d.bucketName}
                    </span>
                  </td>
                  <td className="py-3 px-2">
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1 w-fit">
                      <CheckCircle className="w-3 h-3" /> Auto SSL Active
                    </span>
                  </td>
                  <td className="py-3 px-2 text-slate-400 text-xs">{new Date(d.createdAt).toLocaleDateString()}</td>
                  <td className="py-3 px-2 text-right">
                    <button
                      onClick={() => handleDeleteDomain(d.id)}
                      className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}

              {domains.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-slate-500 text-sm">
                    No custom domain mappings configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Domain Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl space-y-6">
            <h3 className="text-xl font-bold text-white">Add Custom Domain</h3>
            <form onSubmit={handleAddDomain} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Domain Name</label>
                <input
                  type="text"
                  placeholder="cdn.example.com"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value.toLowerCase().trim())}
                  className="w-full bg-dark-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500 font-mono"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Target Storage Bucket</label>
                <select
                  value={selectedBucket}
                  onChange={(e) => setSelectedBucket(e.target.value)}
                  className="w-full bg-dark-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500"
                >
                  {buckets.map((b) => (
                    <option key={b.id} value={b.name}>
                      {b.name}
                    </option>
                  ))}
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
                  Add Domain
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
