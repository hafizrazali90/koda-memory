import type Database from 'better-sqlite3';
import { ftsSearch } from '../search/fts.js';
import { vectorSearch } from '../search/vector.js';
import { graphTraverse } from '../search/graph.js';
import { blendResults, type MemoryMeta } from '../search/blend.js';

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
    Promise.resolve(ftsSearch(db, input.task_description, { limit: limit * 2, operator: 'OR', userId })),
    vectorSearch(db, input.task_description, limit * 2, userId).catch(() => []),
  ]);

  const seedIds = new Set<string>();
  ftsResults.forEach((r) => seedIds.add(r.id));
  vecResults.forEach((r) => seedIds.add(r.id));

  const graphResults = graphTraverse(db, Array.from(seedIds), graphDepth);

  // Collect metadata (recency + signal weighting)
  const allIds = Array.from(seedIds);
  const metaMap = new Map<string, MemoryMeta>();
  if (allIds.length > 0) {
    const placeholders = allIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, created_at, access_count, confidence FROM memories WHERE id IN (${placeholders})`
    ).all(...allIds) as { id: string; created_at: string; access_count: number; confidence: string }[];
    for (const row of rows) {
      metaMap.set(row.id, { created_at: row.created_at, access_count: row.access_count, confidence: row.confidence });
    }
  }

  const blended = blendResults(ftsResults, vecResults, graphResults, limit, metaMap);

  const memories: ContextMemory[] = [];

  if (blended.length > 0) {
    // Batch-fetch all memory rows in a single IN query (eliminates N+1)
    const blendedIds = blended.map((r) => r.id);
    const idPlaceholders = blendedIds.map(() => '?').join(',');

    // Show this user's personal memories + shared team memories + sifututor project memories.
    // Exclude superseded — the graph path can surface a superseded neighbor that the
    // fts/vector source filters already drop. Also exclude soft-deleted rows.
    const memoryRows = db.prepare(
      `SELECT * FROM memories WHERE id IN (${idPlaceholders})
       AND (user_id = ? OR user_id = 'shared' OR user_id = 'sifututor')
       AND superseded_at IS NULL
       AND deleted_at IS NULL`
    ).all(...blendedIds, userId) as any[];
    const memoryById = new Map<string, any>(memoryRows.map((m) => [m.id, m]));

    // Batch-fetch all tags for those IDs in a single IN query
    const tagRows = db.prepare(
      `SELECT memory_id, tag FROM tags WHERE memory_id IN (${idPlaceholders})`
    ).all(...blendedIds) as { memory_id: string; tag: string }[];
    const tagsByMemoryId = new Map<string, string[]>();
    for (const row of tagRows) {
      const list = tagsByMemoryId.get(row.memory_id) ?? [];
      list.push(row.tag);
      tagsByMemoryId.set(row.memory_id, list);
    }

    // Preserve blended sort order, skip rows excluded by the SQL filter
    for (const result of blended) {
      const memory = memoryById.get(result.id);
      if (!memory) continue;

      const sources: string[] = [];
      if (result.sources.fts !== undefined) sources.push('keyword');
      if (result.sources.vector !== undefined) sources.push('semantic');
      if (result.sources.graph !== undefined) sources.push('graph');

      memories.push({
        id: memory.id,
        category: memory.category,
        content: memory.content,
        why: memory.why,
        tags: tagsByMemoryId.get(memory.id) ?? [],
        relevance_score: Math.round(result.score * 100) / 100,
        sources,
      });
    }
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
