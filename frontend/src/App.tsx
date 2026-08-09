import React, { useEffect, useState } from 'react';
import { OverviewTab } from './components/OverviewTab';
import { BucketsTab } from './components/BucketsTab';
import { AccessKeysTab } from './components/AccessKeysTab';
import { CustomDomainsTab } from './components/CustomDomainsTab';
import { Login } from './components/Login';
import { getSession, logout, onUnauthorized } from './api';
import { LayoutDashboard, FolderArchive, Key, Globe, Shield, Cloud, LogOut } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'buckets' | 'keys' | 'domains'>('overview');
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    getSession().then(setAuthenticated);
    return onUnauthorized(() => setAuthenticated(false));
  }, []);

  const handleLogout = async () => {
    await logout();
    setAuthenticated(false);
  };

  if (authenticated === null) {
    return null; // resolving the session cookie before first paint
  }

  if (!authenticated) {
    return <Login onAuthenticated={() => setAuthenticated(true)} />;
  }

  return (
    <div className="min-h-screen bg-dark-900 flex flex-col font-sans">
      {/* Header Bar */}
      <header className="border-b border-slate-800/80 bg-dark-800/60 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-600 to-amber-500 flex items-center justify-center shadow-lg shadow-brand-500/20">
              <Cloud className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-extrabold text-lg tracking-tight font-sans text-white flex items-center gap-2">
                CloudStorage R2 <span className="text-xs px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-400 border border-brand-500/20 font-mono">VPS</span>
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="text-xs font-mono text-slate-400 hidden sm:inline">Server Online</span>
            <button
              onClick={handleLogout}
              title="Lock dashboard"
              className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg transition"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full space-y-6">
        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-800 overflow-x-auto no-scrollbar gap-2">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-4 py-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === 'overview'
                ? 'border-brand-500 text-brand-500 bg-brand-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutDashboard className="w-4 h-4" /> Overview
          </button>
          <button
            onClick={() => setActiveTab('buckets')}
            className={`px-4 py-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === 'buckets'
                ? 'border-brand-500 text-brand-500 bg-brand-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FolderArchive className="w-4 h-4" /> Buckets & Objects
          </button>
          <button
            onClick={() => setActiveTab('keys')}
            className={`px-4 py-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === 'keys'
                ? 'border-brand-500 text-brand-500 bg-brand-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Key className="w-4 h-4" /> API Access Keys
          </button>
          <button
            onClick={() => setActiveTab('domains')}
            className={`px-4 py-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === 'domains'
                ? 'border-brand-500 text-brand-500 bg-brand-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Globe className="w-4 h-4" /> Custom Domains
          </button>
        </div>

        {/* Tab Views */}
        <div className="pt-2">
          {activeTab === 'overview' && <OverviewTab onNavigate={(tab) => setActiveTab(tab as any)} />}
          {activeTab === 'buckets' && <BucketsTab />}
          {activeTab === 'keys' && <AccessKeysTab />}
          {activeTab === 'domains' && <CustomDomainsTab />}
        </div>
      </div>
    </div>
  );
}
