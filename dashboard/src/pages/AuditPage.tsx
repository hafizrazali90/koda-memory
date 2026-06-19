import React, { useEffect, useState, useCallback } from 'react';
import { getAudit } from '../api';
import type { AuditEntry } from '../types';

function ActionBadge({ action }: { action: string }) {
  const colorMap: Record<string, string> = {
    create:  'bg-green-900/60 text-green-300 border border-green-800',
    update:  'bg-blue-900/60 text-blue-300 border border-blue-800',
    delete:  'bg-red-900/60 text-red-300 border border-red-800',
    restore: 'bg-yellow-900/60 text-yellow-300 border border-yellow-800',
    flag:    'bg-orange-900/60 text-orange-300 border border-orange-800',
    relate:  'bg-purple-900/60 text-purple-300 border border-purple-800',
  };
  const key = action.toLowerCase().split('_')[0] || action.toLowerCase();
  const cls = colorMap[key] || 'bg-gray-700 text-gray-300 border border-gray-600';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {action}
    </span>
  );
}

function DiffView({ before, after }: {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}) {
  if (!before && !after) return null;
  const keys = [...new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ])];
  const changed = keys.filter(k =>
    JSON.stringify((before || {})[k]) !== JSON.stringify((after || {})[k])
  );
  if (changed.length === 0) return <span className="text-gray-500 text-xs">no changes</span>;

  return (
    <div className="mt-2 space-y-1">
      {changed.map(k => (
        <div key={k} className="text-xs flex flex-col gap-0.5">
          <span className="text-gray-500 font-medium">{k}</span>
          {before && before[k] !== undefined && (
            <span className="text-red-400 line-through">
              {JSON.stringify(before[k]).slice(0, 120)}
            </span>
          )}
          {after && after[k] !== undefined && (
            <span className="text-green-400">
              {JSON.stringify(after[k]).slice(0, 120)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [memoryFilter, setMemoryFilter] = useState('');
  const [filterInput, setFilterInput] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async (mid?: string) => {
    setLoading(true);
    setError('');
    try {
      const log = await getAudit(mid || undefined);
      setEntries(log.entries || []);
      setTotal(log.total || (log.entries || []).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(memoryFilter || undefined);
  }, [memoryFilter, load]);

  function handleFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMemoryFilter(filterInput.trim());
  }

  function toggleExpand(id: string) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Audit Log</h2>
          <p className="text-gray-400 text-sm mt-0.5">{total.toLocaleString()} entries</p>
        </div>
        <button
          onClick={() => load(memoryFilter || undefined)}
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

      {/* Filter */}
      <form
        onSubmit={handleFilterSubmit}
        className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex gap-3 items-end"
      >
        <div className="flex-1">
          <label className="block text-xs text-gray-400 mb-1">Filter by Memory ID</label>
          <input
            type="text"
            value={filterInput}
            onChange={e => setFilterInput(e.target.value)}
            placeholder="mem_..."
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 text-sm
                       placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition"
        >
          Filter
        </button>
        {memoryFilter && (
          <button
            type="button"
            onClick={() => { setFilterInput(''); setMemoryFilter(''); }}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-400 rounded-lg text-sm transition"
          >
            Clear
          </button>
        )}
      </form>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">{error}</div>
      )}

      {/* Table */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center py-16 text-gray-500">
            <svg className="animate-spin w-6 h-6 mr-3" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Loading...
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            No audit entries{memoryFilter ? ` for memory ${memoryFilter}` : ''}.
          </div>
        )}

        {!loading && entries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-left">
                  <th className="px-4 py-3 text-gray-400 font-medium w-4" />
                  <th className="px-4 py-3 text-gray-400 font-medium">Timestamp</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Action</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Actor</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Memory ID</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <React.Fragment key={entry.id}>
                    <tr
                      className="border-b border-gray-700/50 hover:bg-gray-700/20 transition cursor-pointer"
                      onClick={() => toggleExpand(entry.id)}
                    >
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {(entry.before || entry.after)
                          ? (expandedId === entry.id ? '▼' : '▶')
                          : ''}
                      </td>
                      <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                        {new Date(entry.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <ActionBadge action={entry.action} />
                      </td>
                      <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                        {entry.actor}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-400">
                        <span title={entry.memory_id}>{entry.memory_id.slice(0, 20)}…</span>
                      </td>
                    </tr>
                    {expandedId === entry.id && (entry.before || entry.after) && (
                      <tr className="border-b border-gray-700/50 bg-gray-700/20">
                        <td />
                        <td colSpan={4} className="px-4 py-3">
                          <DiffView before={entry.before} after={entry.after} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
