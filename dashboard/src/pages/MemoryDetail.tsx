import { useEffect, useState } from 'react';
import { getMemory, deleteMemory, restoreMemory, getAudit } from '../api';
import type { MemoryDetail as MemoryDetailType, RelationType, AuditEntry } from '../types';
import { ConfidenceBadge } from './MemoriesPage';

function RelationTypeLabel({ type }: { type: RelationType }) {
  const map: Record<RelationType, { label: string; cls: string }> = {
    'supersedes':  { label: 'supersedes',  cls: 'bg-gray-700 text-gray-300' },
    'contradicts': { label: 'contradicts', cls: 'bg-red-900/60 text-red-300' },
    'relates-to':  { label: 'relates-to',  cls: 'bg-blue-900/60 text-blue-300' },
    'depends-on':  { label: 'depends-on',  cls: 'bg-purple-900/60 text-purple-300' },
  };
  const cfg = map[type] || { label: type, cls: 'bg-gray-700 text-gray-300' };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

interface Props {
  memoryId: string;
  onBack: () => void;
  onNavigate: (id: string) => void;
}

export default function MemoryDetail({ memoryId, onBack, onNavigate }: Props) {
  const [memory, setMemory] = useState<MemoryDetailType | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    Promise.all([
      getMemory(memoryId),
      getAudit(memoryId),
    ])
      .then(([mem, log]) => {
        setMemory(mem);
        setAudit(log.entries || []);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Load failed');
      })
      .finally(() => setLoading(false));
  }, [memoryId]);

  async function handleDelete() {
    if (!confirm('Delete this memory? This action archives it.')) return;
    try {
      await deleteMemory(memoryId);
      setActionMsg('Deleted.');
      if (memory) setMemory({ ...memory, confidence: 'outdated' });
    } catch (err) {
      setActionMsg('Delete failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function handleRestore() {
    try {
      await restoreMemory(memoryId);
      setActionMsg('Restored.');
      if (memory) setMemory({ ...memory, confidence: 'confirmed' });
    } catch (err) {
      setActionMsg('Restore failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-gray-400">
          <svg className="animate-spin w-6 h-6" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading memory...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="text-indigo-400 hover:text-indigo-300 text-sm transition">
          ← Back to Memories
        </button>
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
      </div>
    );
  }

  if (!memory) return null;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <button onClick={onBack} className="text-indigo-400 hover:text-indigo-300 transition">
          ← Memories
        </button>
        <span className="text-gray-600">/</span>
        <span className="text-gray-400 font-mono text-xs">{memory.id.slice(0, 20)}…</span>
      </div>

      {/* Action message */}
      {actionMsg && (
        <div className="bg-indigo-900/40 border border-indigo-700 text-indigo-300 px-4 py-2 rounded-lg text-sm">
          {actionMsg}
        </div>
      )}

      {/* Main card */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 space-y-5">
        {/* Header row */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <ConfidenceBadge value={memory.confidence} />
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-indigo-900/50 text-indigo-300 border border-indigo-800">
                {memory.category}
              </span>
              {memory.flagged && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-orange-900/60 text-orange-300 border border-orange-700">
                  ⚑ Flagged
                </span>
              )}
              {memory.scope === 'project' && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-teal-900/60 text-teal-300 border border-teal-700">
                  project-scope
                </span>
              )}
            </div>
            <p className="font-mono text-xs text-gray-500">{memory.id}</p>
          </div>
          <div className="flex gap-2">
            {memory.confidence === 'outdated' ? (
              <button
                onClick={handleRestore}
                className="px-3 py-1.5 text-sm bg-green-800 hover:bg-green-700 text-green-200 rounded-lg transition"
              >
                Restore
              </button>
            ) : (
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 text-sm bg-red-900 hover:bg-red-800 text-red-300 rounded-lg transition"
              >
                Delete
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div>
          <label className="text-xs text-gray-400 uppercase tracking-wider block mb-2">Content</label>
          <p className="text-gray-100 leading-relaxed whitespace-pre-wrap bg-gray-700/40 rounded-lg p-4 text-sm">
            {memory.content}
          </p>
        </div>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-xs text-gray-400 uppercase tracking-wider block mb-1">User</span>
            <span className="text-gray-200">{memory.user_id}</span>
          </div>
          <div>
            <span className="text-xs text-gray-400 uppercase tracking-wider block mb-1">Project</span>
            <span className="text-gray-200">{memory.project || '—'}</span>
          </div>
          <div>
            <span className="text-xs text-gray-400 uppercase tracking-wider block mb-1">Source</span>
            <span className="text-gray-200">{memory.source || '—'}</span>
          </div>
          <div>
            <span className="text-xs text-gray-400 uppercase tracking-wider block mb-1">Created</span>
            <span className="text-gray-200">{new Date(memory.created_at).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-xs text-gray-400 uppercase tracking-wider block mb-1">Updated</span>
            <span className="text-gray-200">{new Date(memory.updated_at).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-xs text-gray-400 uppercase tracking-wider block mb-1">Access Count</span>
            <span className="text-gray-200">{memory.access_count}</span>
          </div>
          {memory.last_accessed && (
            <div>
              <span className="text-xs text-gray-400 uppercase tracking-wider block mb-1">Last Accessed</span>
              <span className="text-gray-200">{new Date(memory.last_accessed).toLocaleString()}</span>
            </div>
          )}
          {memory.superseded_by && (
            <div>
              <span className="text-xs text-gray-400 uppercase tracking-wider block mb-1">Superseded By</span>
              <button
                onClick={() => onNavigate(memory.superseded_by!)}
                className="text-indigo-400 hover:underline font-mono text-xs"
              >
                {memory.superseded_by.slice(0, 20)}…
              </button>
            </div>
          )}
        </div>

        {/* Tags */}
        {memory.tags && memory.tags.length > 0 && (
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wider block mb-2">Tags</label>
            <div className="flex flex-wrap gap-2">
              {memory.tags.map(t => (
                <span key={t} className="px-2.5 py-1 bg-gray-700 text-gray-300 rounded-full text-xs">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Why */}
        {memory.why && (
          <div>
            <label className="text-xs text-gray-400 uppercase tracking-wider block mb-2">Why</label>
            <p className="text-gray-300 text-sm italic">{memory.why}</p>
          </div>
        )}

        {/* Flag reason */}
        {memory.flagged && memory.flag_reason && (
          <div className="bg-orange-900/20 border border-orange-800 rounded-lg p-3">
            <label className="text-xs text-orange-400 uppercase tracking-wider block mb-1">Flag Reason</label>
            <p className="text-orange-200 text-sm">{memory.flag_reason}</p>
          </div>
        )}
      </div>

      {/* Relations */}
      {memory.relations && memory.relations.length > 0 && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Relations ({memory.relations.length})
          </h3>
          <div className="space-y-3">
            {memory.relations.map((rel, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 bg-gray-700/40 rounded-lg hover:bg-gray-700/60 transition"
              >
                <div className="flex items-center gap-2 shrink-0 pt-0.5">
                  <span className="text-xs text-gray-500">
                    {rel.direction === 'outgoing' ? 'this →' : '← this'}
                  </span>
                  <RelationTypeLabel type={rel.relation_type} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-gray-200 text-sm truncate">{rel.memory.content.slice(0, 100)}…</p>
                  <p className="text-gray-500 text-xs mt-1 font-mono">{rel.memory.id}</p>
                </div>
                <button
                  onClick={() => onNavigate(rel.memory.id)}
                  className="shrink-0 px-2.5 py-1 text-xs bg-indigo-700 hover:bg-indigo-600 text-white
                             rounded transition"
                >
                  View
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Audit log */}
      {audit.length > 0 && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Audit Log ({audit.length})
          </h3>
          <div className="space-y-2">
            {audit.map(entry => (
              <div key={entry.id} className="flex items-start gap-3 text-sm py-2 border-b border-gray-700/50 last:border-0">
                <span className="text-gray-500 text-xs whitespace-nowrap mt-0.5">
                  {new Date(entry.created_at).toLocaleString()}
                </span>
                <span className="text-indigo-400 font-medium whitespace-nowrap">{entry.action}</span>
                <span className="text-gray-400">by</span>
                <span className="text-gray-300">{entry.actor}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
