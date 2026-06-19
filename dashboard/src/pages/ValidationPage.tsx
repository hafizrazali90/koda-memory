import { useEffect, useState, useCallback } from 'react';
import { getValidationQueue, runValidation } from '../api';
import type { ValidationQueue, ValidationJob, ValidationResult } from '../types';

function StatusBadge({ status }: { status: ValidationJob['status'] }) {
  const map: Record<ValidationJob['status'], string> = {
    pending:    'bg-gray-700 text-gray-300',
    processing: 'bg-blue-900/60 text-blue-300',
    done:       'bg-green-900/60 text-green-300',
    failed:     'bg-red-900/60 text-red-300',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${map[status]}`}>
      {status}
    </span>
  );
}

function QueueStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 flex flex-col gap-1">
      <span className="text-xs text-gray-400 uppercase tracking-wider font-medium">{label}</span>
      <span className={`text-3xl font-bold ${color}`}>{value}</span>
    </div>
  );
}

export default function ValidationPage() {
  const [queue, setQueue] = useState<ValidationQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<ValidationResult | null>(null);
  const [runError, setRunError] = useState('');
  const [batchSize, setBatchSize] = useState(10);

  const load = useCallback(async () => {
    try {
      const q = await getValidationQueue();
      setQueue(q);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleRun() {
    if (running) return;
    setRunning(true);
    setRunResult(null);
    setRunError('');
    try {
      const result = await runValidation(batchSize);
      setRunResult(result);
      await load();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  if (loading && !queue) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-gray-400">
          <svg className="animate-spin w-6 h-6" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading validation queue...
        </div>
      </div>
    );
  }

  const jobs = queue?.jobs?.slice(0, 20) || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Validation</h2>
          <p className="text-gray-400 text-sm mt-0.5">Auto-refreshes every 10s</p>
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

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">{error}</div>
      )}

      {/* Stats */}
      {queue && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <QueueStat label="Pending"    value={queue.pending}    color="text-yellow-400" />
          <QueueStat label="Processing" value={queue.processing} color="text-blue-400" />
          <QueueStat label="Done"       value={queue.done}       color="text-green-400" />
          <QueueStat label="Failed"     value={queue.failed}     color="text-red-400" />
        </div>
      )}

      {/* Run validation */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Run Validation</h3>
        <p className="text-gray-400 text-sm">
          Triggers the <code className="bg-gray-700 px-1 py-0.5 rounded text-xs text-indigo-300">validation_run</code> MCP
          tool. The LLM will review a batch of unvalidated memories and update their confidence scores.
        </p>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label htmlFor="batch-size" className="text-sm text-gray-300">Batch size:</label>
            <input
              id="batch-size"
              type="number"
              min={1}
              max={100}
              value={batchSize}
              onChange={e => setBatchSize(Math.max(1, Math.min(100, Number(e.target.value))))}
              className="w-20 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-gray-100
                         text-sm focus:outline-none focus:border-indigo-500 transition"
            />
          </div>
          <button
            onClick={handleRun}
            disabled={running}
            className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500
                       disabled:bg-indigo-800 disabled:cursor-not-allowed text-white font-medium
                       rounded-lg transition"
          >
            {running ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Running...
              </>
            ) : (
              `Run Validation (${batchSize} jobs)`
            )}
          </button>
        </div>

        {/* Run result */}
        {runResult && (
          <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 space-y-2">
            <p className="text-green-300 font-medium text-sm">Validation complete</p>
            <div className="flex gap-6 text-sm">
              <span className="text-gray-300">Processed: <strong className="text-white">{runResult.processed}</strong></span>
              <span className="text-gray-300">Updated: <strong className="text-white">{runResult.updated}</strong></span>
              <span className="text-gray-300">Errors: <strong className="text-red-400">{runResult.errors}</strong></span>
            </div>
            {runResult.details && runResult.details.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Changes</p>
                {runResult.details.map((d, i) => (
                  <div key={i} className="text-xs flex items-start gap-2 text-gray-300 bg-gray-800/60 rounded p-2">
                    <span className="font-mono text-gray-500 shrink-0">{d.id.slice(0, 12)}…</span>
                    <span className="text-red-400 line-through">{d.old}</span>
                    <span className="text-gray-500">→</span>
                    <span className="text-green-400">{d.new}</span>
                    <span className="text-gray-400 italic">{d.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {runError && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm">
            {runError}
          </div>
        )}
      </div>

      {/* Recent jobs */}
      {jobs.length > 0 && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-700">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
              Recent Jobs (last {jobs.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-left">
                  <th className="px-4 py-3 text-gray-400 font-medium">Job ID</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Memory ID</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Status</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Created</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Completed</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Result / Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(job => (
                  <tr key={job.id} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition">
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">
                      {job.id.slice(0, 12)}…
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">
                      {job.memory_id.slice(0, 12)}…
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                      {new Date(job.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                      {job.completed_at ? new Date(job.completed_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs max-w-xs">
                      {job.result && <span className="text-green-400">{job.result}</span>}
                      {job.error && <span className="text-red-400">{job.error}</span>}
                      {!job.result && !job.error && <span className="text-gray-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && jobs.length === 0 && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-12 text-center text-gray-500">
          No validation jobs yet. Click "Run Validation" to start.
        </div>
      )}
    </div>
  );
}
