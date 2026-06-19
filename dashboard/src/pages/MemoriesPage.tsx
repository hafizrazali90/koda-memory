import React, { useEffect, useState, useCallback } from 'react';
import { getMemories, deleteMemory, restoreMemory } from '../api';
import type { Memory, MemoryFilters, Confidence, Category } from '../types';

// ---- Confidence badge ----
export function ConfidenceBadge({ value }: { value: Confidence }) {
  const map: Record<Confidence, string> = {
    confirmed: 'bg-green-900/60 text-green-300 border border-green-700',
    inferred:  'bg-yellow-900/60 text-yellow-300 border border-yellow-700',
    outdated:  'bg-red-900/60 text-red-300 border border-red-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${map[value] || 'bg-gray-700 text-gray-300'}`}>
      {value}
    </span>
  );
}

// ---- Category badge ----
function CategoryBadge({ value }: { value: string }) {
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium bg-indigo-900/50 text-indigo-300 border border-indigo-800">
      {value}
    </span>
  );
}

// ---- Pagination ----
function Pagination({
  page,
  total_pages,
  onPage,
}: {
  page: number;
  total_pages: number;
  onPage: (p: number) => void;
}) {
  if (total_pages <= 1) return null;

  const pages: (number | '...')[] = [];
  if (total_pages <= 7) {
    for (let i = 1; i <= total_pages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push('...');
    for (let i = Math.max(2, page - 1); i <= Math.min(total_pages - 1, page + 1); i++) pages.push(i);
    if (page < total_pages - 2) pages.push('...');
    pages.push(total_pages);
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        className="px-3 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-gray-300
                   disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        Prev
      </button>
      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`ellipsis-${i}`} className="px-2 text-gray-500">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onPage(p as number)}
            className={`px-3 py-1.5 rounded text-sm transition ${
              p === page
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            }`}
          >
            {p}
          </button>
        )
      )}
      <button
        onClick={() => onPage(page + 1)}
        disabled={page >= total_pages}
        className="px-3 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-gray-300
                   disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        Next
      </button>
    </div>
  );
}

// ---- Main page ----
interface Props {
  onViewMemory: (id: string) => void;
}

const CONFIDENCE_OPTIONS: Confidence[] = ['confirmed', 'inferred', 'outdated'];
const CATEGORY_OPTIONS: Category[] = [
  'fact', 'preference', 'rule', 'lesson', 'decision', 'context', 'reference',
];

export default function MemoriesPage({ onViewMemory }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const [filters, setFilters] = useState<MemoryFilters>({ page: 1, per_page: 20 });
  const [search, setSearch] = useState('');

  const load = useCallback(async (f: MemoryFilters) => {
    setLoading(true);
    setError('');
    try {
      const res = await getMemories(f);
      setMemories(res.memories || []);
      setTotal(res.total || 0);
      setTotalPages(res.total_pages || 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filters);
  }, [filters, load]);

  function updateFilter(patch: Partial<MemoryFilters>) {
    setFilters(prev => ({ ...prev, ...patch, page: 1 }));
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateFilter({ q: search });
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this memory?')) return;
    try {
      await deleteMemory(id);
      setActionMsg('Memory deleted.');
      load(filters);
    } catch (err) {
      setActionMsg('Delete failed: ' + (err instanceof Error ? err.message : String(err)));
    }
    setTimeout(() => setActionMsg(''), 3000);
  }

  async function handleRestore(id: string) {
    try {
      await restoreMemory(id);
      setActionMsg('Memory restored.');
      load(filters);
    } catch (err) {
      setActionMsg('Restore failed: ' + (err instanceof Error ? err.message : String(err)));
    }
    setTimeout(() => setActionMsg(''), 3000);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Memories</h2>
          <p className="text-gray-400 text-sm mt-0.5">{total.toLocaleString()} total</p>
        </div>
        <button
          onClick={() => load(filters)}
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

      {/* Action message */}
      {actionMsg && (
        <div className="bg-indigo-900/40 border border-indigo-700 text-indigo-300 px-4 py-2 rounded-lg text-sm">
          {actionMsg}
        </div>
      )}

      {/* Filters */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-wrap gap-3 items-end">
          {/* Search */}
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs text-gray-400 mb-1">Search</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search content..."
                className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100
                           text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition"
              />
              <button
                type="submit"
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition"
              >
                Search
              </button>
            </div>
          </div>

          {/* Confidence */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Confidence</label>
            <select
              value={filters.confidence || ''}
              onChange={e => updateFilter({ confidence: e.target.value as Confidence | '' })}
              className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 text-sm
                         focus:outline-none focus:border-indigo-500 transition"
            >
              <option value="">All</option>
              {CONFIDENCE_OPTIONS.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Category</label>
            <select
              value={filters.category || ''}
              onChange={e => updateFilter({ category: e.target.value as Category | '' })}
              className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 text-sm
                         focus:outline-none focus:border-indigo-500 transition"
            >
              <option value="">All</option>
              {CATEGORY_OPTIONS.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Project */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Project</label>
            <input
              type="text"
              value={filters.project || ''}
              onChange={e => updateFilter({ project: e.target.value })}
              placeholder="any"
              className="w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 text-sm
                         placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition"
            />
          </div>

          {/* User */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">User</label>
            <input
              type="text"
              value={filters.user_id || ''}
              onChange={e => updateFilter({ user_id: e.target.value })}
              placeholder="any"
              className="w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 text-sm
                         placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition"
            />
          </div>

          {/* Flagged */}
          <div className="flex items-center gap-2 self-center mt-4">
            <input
              id="flagged"
              type="checkbox"
              checked={!!filters.flagged}
              onChange={e => updateFilter({ flagged: e.target.checked })}
              className="w-4 h-4 accent-indigo-500"
            />
            <label htmlFor="flagged" className="text-sm text-gray-300 cursor-pointer">Flagged only</label>
          </div>

          {/* Clear */}
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setFilters({ page: 1, per_page: 20 });
            }}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-400 rounded-lg text-sm transition self-end"
          >
            Clear
          </button>
        </form>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 text-left">
                <th className="px-4 py-3 text-gray-400 font-medium">ID</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Content</th>
                <th className="px-4 py-3 text-gray-400 font-medium">User</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Project</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Confidence</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Category</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Created</th>
                <th className="px-4 py-3 text-gray-400 font-medium text-center">Hits</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-500">
                    <div className="flex justify-center items-center gap-2">
                      <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Loading...
                    </div>
                  </td>
                </tr>
              )}
              {!loading && memories.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-500">
                    No memories found
                  </td>
                </tr>
              )}
              {!loading && memories.map(m => (
                <tr
                  key={m.id}
                  className="border-b border-gray-700/50 hover:bg-gray-700/30 transition"
                >
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">
                    <span title={m.id}>{m.id.slice(0, 12)}…</span>
                    {m.flagged && (
                      <span className="ml-1 text-orange-400" title="Flagged">⚑</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-200 max-w-xs">
                    <span className="block truncate" title={m.content}>
                      {m.content.slice(0, 80)}{m.content.length > 80 ? '…' : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                    {m.user_id}
                  </td>
                  <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                    {m.project || <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <ConfidenceBadge value={m.confidence} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <CategoryBadge value={m.category} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                    {new Date(m.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-center">
                    {m.access_count}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex gap-2">
                      <button
                        onClick={() => onViewMemory(m.id)}
                        className="px-2.5 py-1 text-xs bg-indigo-700 hover:bg-indigo-600 text-white
                                   rounded transition"
                      >
                        View
                      </button>
                      {m.confidence === 'outdated' ? (
                        <button
                          onClick={() => handleRestore(m.id)}
                          className="px-2.5 py-1 text-xs bg-green-800 hover:bg-green-700 text-green-200
                                     rounded transition"
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          onClick={() => handleDelete(m.id)}
                          className="px-2.5 py-1 text-xs bg-red-900 hover:bg-red-800 text-red-300
                                     rounded transition"
                        >
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-700 flex items-center justify-between">
            <span className="text-sm text-gray-400">
              Page {filters.page || 1} of {totalPages} ({total.toLocaleString()} records)
            </span>
            <Pagination
              page={filters.page || 1}
              total_pages={totalPages}
              onPage={p => setFilters(prev => ({ ...prev, page: p }))}
            />
          </div>
        )}
      </div>
    </div>
  );
}
