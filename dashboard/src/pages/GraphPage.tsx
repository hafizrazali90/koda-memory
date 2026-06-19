import React, { useEffect, useState, useRef, useCallback } from 'react';
import { getGraph, getMemories } from '../api';
import type { GraphData, GraphNode, GraphLink, Confidence, RelationType } from '../types';

// Lazy-load react-force-graph-2d to avoid SSR issues
// We import it directly since this is a SPA
import ForceGraph2D from 'react-force-graph-2d';

// ---- Color helpers ----
const NODE_COLORS: Record<Confidence, string> = {
  confirmed: '#22c55e',  // green-500
  inferred:  '#eab308',  // yellow-500
  outdated:  '#ef4444',  // red-500
};

const LINK_COLORS: Record<RelationType, string> = {
  'supersedes':  '#6b7280',  // gray-500
  'contradicts': '#ef4444',  // red-500
  'relates-to':  '#3b82f6',  // blue-500
  'depends-on':  '#a855f7',  // purple-500
};

function nodeColor(node: GraphNode): string {
  return NODE_COLORS[node.confidence] || '#6b7280';
}

function nodeSize(node: GraphNode): number {
  const count = node.access_count || 0;
  return Math.min(Math.max(4, 4 + Math.log1p(count) * 2), 12);
}

function linkColor(link: GraphLink): string {
  return LINK_COLORS[link.relation_type] || '#6b7280';
}

// ---- Legend ----
function Legend() {
  return (
    <div className="absolute bottom-4 left-4 bg-gray-900/90 border border-gray-700 rounded-xl p-4 text-xs space-y-3">
      <div>
        <p className="text-gray-400 font-semibold mb-1.5 uppercase tracking-wider">Nodes</p>
        <div className="space-y-1">
          {(Object.entries(NODE_COLORS) as [Confidence, string][]).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full inline-block" style={{ background: v }} />
              <span className="text-gray-300">{k}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <p className="text-gray-400 font-semibold mb-1.5 uppercase tracking-wider">Links</p>
        <div className="space-y-1">
          {(Object.entries(LINK_COLORS) as [RelationType, string][]).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-6 h-0.5 inline-block" style={{ background: v }} />
              <span className="text-gray-300">{k}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <p className="text-gray-500">Node size ∝ access count</p>
      </div>
    </div>
  );
}

// ---- Side panel ----
function NodePanel({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  const conf = node.confidence;
  const colors: Record<Confidence, string> = {
    confirmed: 'text-green-400',
    inferred:  'text-yellow-400',
    outdated:  'text-red-400',
  };
  return (
    <div className="absolute top-4 right-4 w-80 bg-gray-900/95 border border-gray-700 rounded-xl p-4 shadow-2xl">
      <div className="flex items-start justify-between mb-3">
        <div>
          <span className={`text-xs font-semibold uppercase ${colors[conf] || 'text-gray-400'}`}>
            {conf}
          </span>
          {node.category && (
            <span className="ml-2 text-xs text-indigo-400">{node.category}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 text-lg leading-none transition"
        >
          ×
        </button>
      </div>
      <p className="text-gray-100 text-sm leading-relaxed mb-3 max-h-40 overflow-y-auto">
        {node.content}
      </p>
      <div className="space-y-1 text-xs text-gray-400">
        {node.project && (
          <div className="flex justify-between">
            <span>Project</span>
            <span className="text-gray-300">{node.project}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span>Access count</span>
          <span className="text-gray-300">{node.access_count}</span>
        </div>
        <div className="mt-2 text-gray-600 font-mono break-all">{node.id}</div>
      </div>
    </div>
  );
}

// ---- Main page ----
export default function GraphPage() {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [project, setProject] = useState('');
  const [projectInput, setProjectInput] = useState('');
  const [mode, setMode] = useState<'connected' | 'all'>('connected');
  const [focus, setFocus] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchMsg, setSearchMsg] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    function measure() {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    }
    measure();
    const obs = new ResizeObserver(measure);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getGraph({
        project: project || undefined,
        focus: focus || undefined,
        depth: focus ? 2 : undefined,
        mode,
      });
      setGraph(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [project, focus, mode]);

  useEffect(() => {
    load();
  }, [load]);

  function handleFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setProject(projectInput.trim());
  }

  // Search-to-node: find the first memory matching the query and focus the graph on it.
  async function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = search.trim();
    if (!q) return;
    setSearchMsg('Searching…');
    try {
      const res = await getMemories({ q, per_page: 1, project: project || undefined });
      if (res.memories.length > 0) {
        setSearchMsg('');
        setFocus(res.memories[0].id);
      } else {
        setSearchMsg('No memory matched.');
      }
    } catch {
      setSearchMsg('Search failed.');
    }
  }

  // Click a node → focus the graph on its neighbourhood (and show its detail).
  const handleNodeClick = useCallback((node: object) => {
    const n = node as GraphNode;
    setSelectedNode(n);
    setFocus(n.id);
  }, []);

  // Prepare graph data for force-graph
  const graphData = graph
    ? {
        nodes: graph.nodes.map(n => ({ ...n })),
        links: graph.links.map(l => ({ ...l })),
      }
    : { nodes: [], links: [] };

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 'calc(100vh - 120px)' }}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-2xl font-bold text-white">Knowledge Graph</h2>

        {/* Mode toggle: connected (default) vs all */}
        <div className="flex rounded-lg overflow-hidden border border-gray-600 text-sm" title="Connected = only memories with links; All = every memory">
          {(['connected', 'all'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={!!focus}
              className={`px-3 py-2 transition ${mode === m ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'} ${focus ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {m === 'connected' ? 'Connected' : 'All'}
            </button>
          ))}
        </div>

        {/* Search-to-node */}
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Find a memory → focus..."
            className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 text-sm
                       placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition w-52"
          />
          <button type="submit" className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition">
            Focus
          </button>
        </form>

        <form onSubmit={handleFilterSubmit} className="flex gap-2 ml-auto">
          <input
            type="text"
            value={projectInput}
            onChange={e => setProjectInput(e.target.value)}
            placeholder="Filter by project..."
            className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 text-sm
                       placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition w-48"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition"
          >
            Filter
          </button>
          {project && (
            <button
              type="button"
              onClick={() => { setProjectInput(''); setProject(''); }}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-400 text-sm rounded-lg transition"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Status row: focus chip + counts */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        {focus && (
          <span className="flex items-center gap-2 px-3 py-1 bg-indigo-900/40 border border-indigo-700 rounded-full text-indigo-200">
            Focused on neighbourhood of <span className="font-mono text-xs">{focus.slice(0, 16)}</span>
            <button
              type="button"
              onClick={() => setFocus(null)}
              className="text-indigo-300 hover:text-white"
              title="Show the full graph again"
            >
              ✕ clear focus
            </button>
          </span>
        )}
        {searchMsg && <span className="text-gray-400">{searchMsg}</span>}
        {graph && (
          <span className="text-gray-400">
            {graph.nodes.length} nodes, {graph.links.length} links
            {!focus && mode === 'connected' && ' (connected only)'}
          </span>
        )}
      </div>

      {/* Graph container */}
      <div
        ref={containerRef}
        className="relative flex-1 bg-gray-800 border border-gray-700 rounded-xl overflow-hidden"
        style={{ minHeight: 500 }}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-800/80 z-10">
            <div className="flex items-center gap-3 text-gray-400">
              <svg className="animate-spin w-6 h-6" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading graph...
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300 text-sm max-w-md text-center">
              <strong>Error:</strong> {error}
              <br />
              <button onClick={() => load()} className="mt-3 underline hover:no-underline text-sm">
                Retry
              </button>
            </div>
          </div>
        )}

        {!loading && !error && graph && graph.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-center px-6">
            {mode === 'connected' && !focus && !project
              ? 'No linked memories yet. Connections appear as the validation worker confirms duplicates and contradictions — switch to "All" to see every memory.'
              : `No nodes to display${project ? ` for project "${project}"` : ''}.`}
          </div>
        )}

        {!loading && !error && graph && graph.nodes.length > 0 && (
          <ForceGraph2D
            graphData={graphData}
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor="#1f2937"
            nodeColor={node => nodeColor(node as GraphNode)}
            nodeVal={node => nodeSize(node as GraphNode)}
            linkColor={link => linkColor(link as GraphLink)}
            linkWidth={1.5}
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={1}
            nodeLabel={node => (node as GraphNode).content?.slice(0, 80) || (node as GraphNode).id}
            onNodeClick={handleNodeClick}
            nodeCanvasObjectMode={() => 'after'}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as GraphNode & { x?: number; y?: number };
              if (!n.x || !n.y) return;
              const label = n.content?.slice(0, 25) || n.id.slice(0, 12);
              const fontSize = 10 / globalScale;
              ctx.font = `${fontSize}px Sans-Serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillStyle = 'rgba(156, 163, 175, 0.9)';
              ctx.fillText(label, n.x, n.y + nodeSize(n) + 2);
            }}
          />
        )}

        {/* Legend */}
        <Legend />

        {/* Node detail panel */}
        {selectedNode && (
          <NodePanel node={selectedNode} onClose={() => setSelectedNode(null)} />
        )}
      </div>
    </div>
  );
}
