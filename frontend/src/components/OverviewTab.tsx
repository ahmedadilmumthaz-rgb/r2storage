import React, { useEffect, useState } from 'react';
import { HardDrive, FolderArchive, Key, Globe, Activity, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { adminFetch } from '../api';

interface OverviewData {
  bucketsCount: number;
  objectsCount: number;
  totalStorageBytes: number;
  accessKeysCount: number;
  customDomainsCount: number;
  recentLogs: Array<{
    id: string;
    bucketName?: string;
    method: string;
    path: string;
    status: number;
    ip: string;
    bytesTransferred: number;
    createdAt: string;
  }>;
}

export const OverviewTab: React.FC<{ onNavigate: (tab: string) => void }> = ({ onNavigate }) => {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOverview = async () => {
    try {
      const res = await adminFetch('/api/admin/overview');
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to fetch overview stats', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-brand-500 border-r-transparent"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Top Banner */}
      <div className="glass-panel p-6 rounded-2xl relative overflow-hidden flex flex-col md:flex-row md:items-center justify-between gap-6 border-l-4 border-l-brand-500">
        <div className="space-y-1 z-10">
          <div className="flex items-center gap-2 text-brand-500 font-semibold text-sm uppercase tracking-wider">
            <ShieldCheck className="w-4 h-4" /> VPS Object Storage Engine Active
          </div>
          <h2 className="text-2xl font-bold font-sans text-white">Cloudflare R2 Compatible Platform</h2>
          <p className="text-slate-400 text-sm">
            High-performance object storage with automated SSL, custom domains, and AWS S3 V4 protocol compatibility.
          </p>
        </div>
        <div className="flex items-center gap-3 z-10">
          <button
            onClick={() => onNavigate('buckets')}
            className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-xl shadow-lg shadow-brand-500/20 transition flex items-center gap-2 text-sm"
          >
            Create Bucket <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="glass-card p-5 rounded-2xl flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-slate-400 text-xs uppercase font-medium tracking-wider">Total Storage</span>
            <div className="text-2xl font-bold text-white">{formatBytes(data?.totalStorageBytes || 0)}</div>
          </div>
          <div className="p-3 bg-brand-500/10 text-brand-500 rounded-xl">
            <HardDrive className="w-6 h-6" />
          </div>
        </div>

        <div className="glass-card p-5 rounded-2xl flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-slate-400 text-xs uppercase font-medium tracking-wider">Active Buckets</span>
            <div className="text-2xl font-bold text-white">{data?.bucketsCount || 0}</div>
          </div>
          <div className="p-3 bg-blue-500/10 text-blue-400 rounded-xl">
            <FolderArchive className="w-6 h-6" />
          </div>
        </div>

        <div className="glass-card p-5 rounded-2xl flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-slate-400 text-xs uppercase font-medium tracking-wider">API Access Keys</span>
            <div className="text-2xl font-bold text-white">{data?.accessKeysCount || 0}</div>
          </div>
          <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-xl">
            <Key className="w-6 h-6" />
          </div>
        </div>

        <div className="glass-card p-5 rounded-2xl flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-slate-400 text-xs uppercase font-medium tracking-wider">Custom Domains</span>
            <div className="text-2xl font-bold text-white">{data?.customDomainsCount || 0}</div>
          </div>
          <div className="p-3 bg-purple-500/10 text-purple-400 rounded-xl">
            <Globe className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Recent Request Logs */}
      <div className="glass-panel p-6 rounded-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-brand-500" />
            <h3 className="text-lg font-semibold text-white">Live Activity & Request Logs</h3>
          </div>
          <span className="text-xs text-slate-400 bg-dark-800 px-3 py-1 rounded-full border border-slate-700">
            Realtime Auto-refresh
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase font-medium">
                <th className="pb-3 px-2">Method</th>
                <th className="pb-3 px-2">Bucket</th>
                <th className="pb-3 px-2">Path</th>
                <th className="pb-3 px-2">Status</th>
                <th className="pb-3 px-2">Client IP</th>
                <th className="pb-3 px-2 text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data?.recentLogs && data.recentLogs.length > 0 ? (
                data.recentLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3 px-2 font-mono text-xs">
                      <span
                        className={`px-2 py-0.5 rounded font-semibold ${
                          log.method === 'GET'
                            ? 'bg-blue-500/10 text-blue-400'
                            : log.method === 'PUT'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-rose-500/10 text-rose-400'
                        }`}
                      >
                        {log.method}
                      </span>
                    </td>
                    <td className="py-3 px-2 text-slate-300">{log.bucketName || 'system'}</td>
                    <td className="py-3 px-2 text-slate-400 font-mono text-xs truncate max-w-xs">{log.path}</td>
                    <td className="py-3 px-2">
                      <span className="text-emerald-400 font-medium">{log.status}</span>
                    </td>
                    <td className="py-3 px-2 text-slate-400 font-mono text-xs">{log.ip}</td>
                    <td className="py-3 px-2 text-slate-400 text-right text-xs">
                      {new Date(log.createdAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500 text-xs">
                    No requests recorded yet. Upload or request files via S3 API or public link.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
