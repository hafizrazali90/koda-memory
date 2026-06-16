import type Database from 'better-sqlite3';
import { ftsSearch } from '../search/fts.js';
import { vectorSearch } from '../search/vector.js';
import { graphTraverse } from '../search/graph.js';
import { blendResults } from '../search/blend.js';

export interface MemoryContextInput {
  task_description: string;
  limit?: number;
  graph_depth?: number;
}

export interface ContextMemory {
  id: string;
  category: string;
  content: string;
  why: string | null;
  tags: string[];
  relevance_score: number;
  sources: string[];
}

export interface MemoryContextResult {
  memories: ContextMemory[];
  total_found: number;
  search_summary: string;
}

export async function memoryContext(
  db: Database.Database,
  userId: string,
  input: MemoryContextInput
): Promise<MemoryContextResult> {
  const limit = input.limit ?? 15;
  const graphDepth = Math.min(input.graph_depth ?? 1, 3);

  const [ftsResults, vecResults] = await Promise.all([
    Promise.resolve(ftsSearch(db, input.task_description, { limit: limit * 2, operator: 'OR' })),
    vectorSearch(db, input.task_description, limit * 2).catch(() => []),
  ]);

  const seedIds = new Set<string>();
  ftsResults.forEach((r) => seedIds.add(r.id));
  vecResults.forEach((r) => seedIds.add(r.id));

  const graphResults = graphTraverse(db, Array.from(seedIds), graphDepth);
  const blended = blendResults(ftsResults, vecResults, graphResults, limit);

  const memories: ContextMemory[] = [];

  for (const result of blended) {
    // Only show memories belonging to this user or shared team memories
    const memory = db.prepare(
      'SELECT * FROM memories WHERE id = ? AND (user_id = ? OR user_id = ?)'
    ).get(result.id, userId, 'shared') as any;
    if (!memory) continue;

    const tags = db.prepare('SELECT tag FROM tags WHERE memory_id = ?').all(result.id) as { tag: string }[];

    const sources: string[] = [];
    if (result.sources.fts !== undefined) sources.push('keyword');
    if (result.sources.vector !== undefined) sources.push('semantic');
    if (result.sources.graph !== undefined) sources.push('graph');

    memories.push({
      id: memory.id,
      category: memory.category,
      content: memory.content,
      why: memory.why,
      tags: tags.map((t) => t.tag),
      relevance_score: Math.round(result.score * 100) / 100,
      sources,
    });
  }

  const updateAccess = db.prepare(
    'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const m of memories) updateAccess.run(now, m.id);
  })();

  return {
    memories,
    total_found: memories.length,
    search_summary: `Found ${memories.length} relevant memories (keyword: ${ftsResults.length}, semantic: ${vecResults.length}, graph: ${graphResults.length} connections)`,
  };
}
