import type Database from 'better-sqlite3';
import { ftsSearch } from '../search/fts.js';
import { vectorSearch } from '../search/vector.js';
import { graphTraverse } from '../search/graph.js';
import { blendResults } from '../search/blend.js';

export interface MemoryContextInput {
  task_description: string;
  limit?: number;
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
  input: MemoryContextInput
): Promise<MemoryContextResult> {
  const limit = input.limit ?? 15;

  // 1. Run FTS5 and vector search in parallel
  const [ftsResults, vecResults] = await Promise.all([
    Promise.resolve(ftsSearch(db, input.task_description, { limit: limit * 2, operator: 'OR' })),
    vectorSearch(db, input.task_description, limit * 2).catch(() => []),
  ]);

  // 2. Collect seed IDs from FTS + vector for graph traversal
  const seedIds = new Set<string>();
  ftsResults.forEach((r) => seedIds.add(r.id));
  vecResults.forEach((r) => seedIds.add(r.id));

  // 3. Graph traversal from matched memories (1 level deep)
  const graphResults = graphTraverse(db, Array.from(seedIds), 1);

  // 4. Blend scores: FTS5 40% + Vector 40% + Graph 20%
  const blended = blendResults(ftsResults, vecResults, graphResults, limit);

  // 5. Enrich with full memory data
  const memories: ContextMemory[] = [];

  for (const result of blended) {
    const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id) as any;
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

  // Update access tracking
  const updateAccess = db.prepare(
    'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const m of memories) {
      updateAccess.run(now, m.id);
    }
  })();

  // Build summary
  const ftsCount = ftsResults.length;
  const vecCount = vecResults.length;
  const graphCount = graphResults.length;

  return {
    memories,
    total_found: memories.length,
    search_summary: `Found ${memories.length} relevant memories (keyword: ${ftsCount}, semantic: ${vecCount}, graph: ${graphCount} connections)`,
  };
}
