import React, { useEffect, useState } from 'react';
import { FolderPlus, Globe, Lock, Trash2, UploadCloud, FileText, Link2, ArrowLeft, RefreshCw, Copy, Check } from 'lucide-react';
import { adminFetch } from '../api';

interface Bucket {
  id: string;
  name: string;
  isPublic: boolean;
  corsOrigins: string;
  objectCount: number;
  totalSizeBytes: number;
  createdAt: string;
}

interface StorageObject {
  id: string;
  bucketName: string;
  key: string;
  size: number;
  contentType: string;
  etag: string;
  createdAt: string;
}

export const BucketsTab: React.FC = () => {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<Bucket | null>(null);
  const [objects, setObjects] = useState<StorageObject[]>([]);

  // Create Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [isPublic, setIsPublic] = useState(false);

  // Upload State
  const [uploading, setUploading] = useState(false);

  // Presigned URL Modal State
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchBuckets = async () => {
    try {
      const res = await adminFetch('/api/admin/buckets');
      const json = await res.json();
      setBuckets(json);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchObjects = async (bucketName: string) => {
    try {
      const res = await adminFetch(`/api/admin/buckets/${bucketName}/objects`);
      const json = await res.json();
      setObjects(json);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchBuckets();
  }, []);

  useEffect(() => {
    if (selectedBucket) {
      fetchObjects(selectedBucket.name);
    }
  }, [selectedBucket]);

  const handleCreateBucket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBucketName) return;

    try {
      const res = await adminFetch('/api/admin/buckets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newBucketName, isPublic }),
      });
      if (res.ok) {
        setNewBucketName('');
        setShowCreateModal(false);
        fetchBuckets();
      } else {
        const errorData = await res.json();
        alert(errorData.error || 'Failed to create bucket');
      }
    } catch (err) {
      alert('Error creating bucket');
    }
  };

  const handleTogglePublic = async (bucket: Bucket) => {
    try {
      const res = await adminFetch(`/api/admin/buckets/${bucket.name}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublic: !bucket.isPublic }),
      });
      if (res.ok) {
        fetchBuckets();
        if (selectedBucket && selectedBucket.name === bucket.name) {
          setSelectedBucket({ ...selectedBucket, isPublic: !bucket.isPublic });
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteBucket = async (bucketName: string) => {
    if (!confirm(`Are you sure you want to delete bucket "${bucketName}" and ALL objects in it?`)) return;

    try {
      await adminFetch(`/api/admin/buckets/${bucketName}`, { method: 'DELETE' });
      if (selectedBucket?.name === bucketName) setSelectedBucket(null);
      fetchBuckets();
    } catch (err) {
      console.error(err);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0] || !selectedBucket) return;
    const file = e.target.files[0];
    setUploading(true);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await adminFetch(`/api/admin/buckets/${selectedBucket.name}/upload`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        fetchObjects(selectedBucket.name);
        fetchBuckets();
      } else {
        alert('Upload failed');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteObject = async (key: string) => {
    if (!selectedBucket) return;
    try {
      await adminFetch(`/api/admin/buckets/${selectedBucket.name}/objects/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      fetchObjects(selectedBucket.name);
      fetchBuckets();
    } catch (err) {
      console.error(err);
    }
  };

  const handleGeneratePresignedUrl = async (key: string) => {
    if (!selectedBucket) return;
    try {
      const res = await adminFetch(`/api/admin/buckets/${selectedBucket.name}/presigned`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, expiresInSeconds: 3600 }),
      });
      const json = await res.json();
      if (json.url) {
        setPresignedUrl(json.url);
      } else {
        alert(json.error || 'Failed to generate presigned URL');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          {selectedBucket ? (
            <button
              onClick={() => setSelectedBucket(null)}
              className="text-slate-400 hover:text-white flex items-center gap-1 text-sm font-medium transition"
            >
              <ArrowLeft className="w-4 h-4" /> Back to Buckets
            </button>
          ) : (
            <>
              <h2 className="text-xl font-bold text-white">Storage Buckets</h2>
              <p className="text-slate-400 text-sm">Create and manage S3 compatible buckets and objects</p>
            </>
          )}
        </div>

        {!selectedBucket && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-xl shadow-lg shadow-brand-500/20 transition flex items-center gap-2 text-sm"
          >
            <FolderPlus className="w-4 h-4" /> Create Bucket
          </button>
        )}
      </div>

      {/* Bucket List View */}
      {!selectedBucket ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {buckets.map((bucket) => (
            <div key={bucket.id} className="glass-card p-6 rounded-2xl flex flex-col justify-between space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-lg text-white font-mono">{bucket.name}</span>
                  <button
                    onClick={() => handleTogglePublic(bucket)}
                    title={bucket.isPublic ? 'Public Access Enabled' : 'Private Access Only'}
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 ${
                      bucket.isPublic
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                        : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                    }`}
                  >
                    {bucket.isPublic ? <Globe className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                    {bucket.isPublic ? 'Public' : 'Private'}
                  </button>
                </div>
                <div className="flex items-center gap-4 text-slate-400 text-xs font-mono">
                  <span>{bucket.objectCount} objects</span>
                  <span>•</span>
                  <span>{formatBytes(bucket.totalSizeBytes)}</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-slate-800/80">
                <button
                  onClick={() => setSelectedBucket(bucket)}
                  className="text-brand-500 hover:text-brand-400 font-medium text-sm flex items-center gap-1"
                >
                  Explore Objects &rarr;
                </button>
                <button
                  onClick={() => handleDeleteBucket(bucket.name)}
                  className="text-slate-500 hover:text-rose-400 p-1.5 rounded-lg transition"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}

          {buckets.length === 0 && (
            <div className="col-span-full glass-panel p-12 rounded-2xl text-center space-y-3">
              <FolderPlus className="w-12 h-12 text-slate-600 mx-auto" />
              <h3 className="text-lg font-semibold text-white">No Storage Buckets Yet</h3>
              <p className="text-slate-400 text-sm max-w-sm mx-auto">
                Create your first S3 compatible bucket to start uploading and serving files.
              </p>
              <button
                onClick={() => setShowCreateModal(true)}
                className="mt-4 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-xl shadow-lg"
              >
                Create Bucket Now
              </button>
            </div>
          )}
        </div>
      ) : (
        /* Single Bucket Object Explorer */
        <div className="space-y-6">
          <div className="glass-panel p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h2 className="text-2xl font-bold font-mono text-white">{selectedBucket.name}</h2>
                <button
                  onClick={() => handleTogglePublic(selectedBucket)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 ${
                    selectedBucket.isPublic
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                  }`}
                >
                  {selectedBucket.isPublic ? <Globe className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                  {selectedBucket.isPublic ? 'Public' : 'Private'}
                </button>
              </div>
              <p className="text-slate-400 text-xs font-mono">
                S3 Endpoint Path: /s3/{selectedBucket.name}/[key]
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => fetchObjects(selectedBucket.name)}
                className="p-2.5 glass-card text-slate-300 hover:text-white rounded-xl"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <label className="px-4 py-2.5 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-xl shadow-lg shadow-brand-500/20 cursor-pointer transition flex items-center gap-2 text-sm">
                <UploadCloud className="w-4 h-4" />
                {uploading ? 'Uploading...' : 'Upload Object'}
                <input type="file" onChange={handleFileUpload} className="hidden" disabled={uploading} />
              </label>
            </div>
          </div>

          {/* Objects Table */}
          <div className="glass-panel p-6 rounded-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase font-medium">
                    <th className="pb-3 px-2">Key / File Name</th>
                    <th className="pb-3 px-2">Content Type</th>
                    <th className="pb-3 px-2">Size</th>
                    <th className="pb-3 px-2">Uploaded</th>
                    <th className="pb-3 px-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {objects.map((obj) => (
                    <tr key={obj.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3 px-2 font-mono text-sm text-white flex items-center gap-2">
                        <FileText className="w-4 h-4 text-brand-500" />
                        {obj.key}
                      </td>
                      <td className="py-3 px-2 text-slate-400 text-xs font-mono">{obj.contentType}</td>
                      <td className="py-3 px-2 text-slate-400 text-xs font-mono">{formatBytes(obj.size)}</td>
                      <td className="py-3 px-2 text-slate-400 text-xs">
                        {new Date(obj.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-3 px-2 text-right space-x-2">
                        <button
                          onClick={() => handleGeneratePresignedUrl(obj.key)}
                          title="Generate Presigned URL"
                          className="p-1.5 text-slate-400 hover:text-brand-400 rounded-lg transition"
                        >
                          <Link2 className="w-4 h-4" />
                        </button>
                        <a
                          href={`/s3/${selectedBucket.name}/${obj.key}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Open Direct Link"
                          className="p-1.5 text-slate-400 hover:text-blue-400 rounded-lg inline-block"
                        >
                          <Globe className="w-4 h-4" />
                        </a>
                        <button
                          onClick={() => handleDeleteObject(obj.key)}
                          title="Delete Object"
                          className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg transition"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}

                  {objects.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-500 text-sm">
                        No objects inside this bucket yet. Click "Upload Object" above.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Create Bucket Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl space-y-6">
            <h3 className="text-xl font-bold text-white">Create S3 Bucket</h3>
            <form onSubmit={handleCreateBucket} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Bucket Name</label>
                <input
                  type="text"
                  placeholder="my-storage-bucket"
                  value={newBucketName}
                  onChange={(e) => setNewBucketName(e.target.value.toLowerCase().trim())}
                  className="w-full bg-dark-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500"
                  required
                />
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="isPublic"
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                  className="w-4 h-4 accent-brand-500"
                />
                <label htmlFor="isPublic" className="text-sm text-slate-300">
                  Allow Public Object Read Access
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-slate-400 hover:text-white text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-xl shadow-lg shadow-brand-500/20"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Presigned URL Modal */}
      {presignedUrl && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-lg p-6 rounded-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">Presigned URL Generated</h3>
            <p className="text-xs text-slate-400">Valid for 1 Hour (3600 seconds)</p>
            <div className="p-3 bg-dark-900 border border-slate-800 rounded-xl font-mono text-xs text-brand-400 break-all">
              {presignedUrl}
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(presignedUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="px-4 py-2 bg-brand-500 text-white rounded-xl text-sm font-medium flex items-center gap-1.5"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied!' : 'Copy Link'}
              </button>
              <button
                onClick={() => setPresignedUrl(null)}
                className="px-4 py-2 text-slate-400 hover:text-white text-sm font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
