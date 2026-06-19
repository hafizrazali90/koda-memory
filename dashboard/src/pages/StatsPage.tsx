import { useEffect, useState, useCallback } from 'react';
import { getStats } from '../api';
import type { Stats } from '../types';

// ---- Stat card ----
function StatCard({ label, value, color = 'indigo' }: { label: string; value: number | string; color?: string }) {
  const colors: Record<string, string> = {
    indigo: 'text-indigo-400',
    green:  'text-green-400',
    yellow: 'text-yellow-400',
    red:    'text-red-400',
    orange: 'text-orange-400',
    blue:   'text-blue-400',
    purple: 'text-purple-400',
    gray:   'text-gray-400',
  };
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 flex flex-col gap-1">
      <span className="text-xs text-gray-400 uppercase tracking-wider font-medium">{label}</span>
      <span className={`text-3xl font-bold ${colors[color] || colors.indigo}`}>{value}</span>
    </div>
  );
}

// ---- Horizontal bar chart (inline divs) ----
function BarChart({ title, data, keyLabel }: {
  title: string;
  data: Array<{ label: string; count: number }>;
  keyLabel: string;
}) {
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">{title}</h3>
      {data.length === 0 && (
        <p className="text-gray-500 text-sm">No data available</p>
      )}
      <div className="space-y-3">
        {data.map(row => (
          <div key={row.label} className="flex items-center gap-3">
            <span className="text-gray-300 text-sm w-32 shrink-0 truncate" title={row.label}>
              {row.label || '(none)'}
            </span>
            <div className="flex-1 bg-gray-700 rounded-full h-3 overflow-hidden">
              <div
                className="h-3 rounded-full bg-indigo-500 transition-all duration-500"
                style={{ width: `${Math.max((row.count / max) * 100, 2)}%` }}
              />
            </div>
            <span className="text-gray-400 text-sm w-10 text-right shrink-0">{row.count}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-600 mt-3">Top 5 by {keyLabel}</p>
    </div>
  );
}

// ---- Main page ----
export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getStats();
      setStats(data);
      setError('');
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-gray-400">
          <svg className="animate-spin w-6 h-6" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading stats...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">
        <strong>Error:</strong> {error}
        <button onClick={load} className="ml-4 underline hover:no-underline text-sm">Retry</button>
      </div>
    );
  }

  if (!stats) return null;

  const topUsers = [...(stats.by_user || [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(u => ({ label: u.user_id, count: u.count }));

  const topProjects = [...(stats.by_project || [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(p => ({ label: p.project || '(none)', count: p.count }));

  const topCategories = [...(stats.by_category || [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(c => ({ label: c.category, count: c.count }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Overview</h2>
          {lastRefresh && (
            <p className="text-xs text-gray-500 mt-1">
              Last refreshed {lastRefresh.toLocaleTimeString()} — auto-refreshes every 30s
            </p>
          )}
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300
                     rounded-lg text-sm transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total Memories" value={stats.total} color="indigo" />
        <StatCard label="Confirmed" value={stats.confirmed} color="green" />
        <StatCard label="Flagged" value={stats.flagged} color="orange" />
        <StatCard label="Superseded" value={stats.superseded} color="gray" />
        <StatCard label="Inferred" value={stats.inferred} color="yellow" />
        <StatCard label="Outdated" value={stats.outdated} color="red" />
        <StatCard label="Queue Depth" value={stats.queue_depth} color="blue" />
        <StatCard label="Search Gaps" value={stats.search_gaps} color="purple" />
      </div>

      {/* Confidence breakdown mini bars */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Confidence Breakdown</h3>
        <div className="flex items-center gap-2 h-8">
          {stats.total > 0 && (
            <>
              <div
                className="h-full rounded-l bg-green-600 flex items-center justify-center text-xs text-white font-medium px-2 min-w-[2rem]"
                style={{ width: `${(stats.confirmed / stats.total) * 100}%` }}
                title={`Confirmed: ${stats.confirmed}`}
              >
                {stats.confirmed > 0 && `${Math.round((stats.confirmed / stats.total) * 100)}%`}
              </div>
              <div
                className="h-full bg-yellow-600 flex items-center justify-center text-xs text-white font-medium px-2 min-w-[2rem]"
                style={{ width: `${(stats.inferred / stats.total) * 100}%` }}
                title={`Inferred: ${stats.inferred}`}
              >
                {stats.inferred > 0 && `${Math.round((stats.inferred / stats.total) * 100)}%`}
              </div>
              <div
                className="h-full rounded-r bg-red-700 flex items-center justify-center text-xs text-white font-medium px-2 min-w-[2rem]"
                style={{ width: `${(stats.outdated / stats.total) * 100}%` }}
                title={`Outdated: ${stats.outdated}`}
              >
                {stats.outdated > 0 && `${Math.round((stats.outdated / stats.total) * 100)}%`}
              </div>
            </>
          )}
          {stats.total === 0 && <span className="text-gray-500 text-sm">No memories yet</span>}
        </div>
        <div className="flex gap-4 mt-3 text-xs text-gray-400">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-green-600 inline-block" /> Confirmed
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-yellow-600 inline-block" /> Inferred
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-red-700 inline-block" /> Outdated
          </span>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <BarChart title="Top Users" data={topUsers} keyLabel="user" />
        <BarChart title="Top Projects" data={topProjects} keyLabel="project" />
        <BarChart title="Top Categories" data={topCategories} keyLabel="category" />
      </div>
    </div>
  );
}
