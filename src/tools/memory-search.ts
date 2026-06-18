import type Database from 'better-sqlite3';
import { ftsSearch } from '../search/fts.js';
import { vectorSearch } from '../search/vector.js';
import { blendResults, type MemoryMeta } from '../search/blend.js';

export interface MemorySearchInput {
  query: string;
  category?: string;
  tags?: string[];
  limit?: number;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  why: string | null;
  category: string;
  tags: string[];
  score: number;
  source: 'fts' | 'vector' | 'graph' | 'blended';
}

// userId sees their own memories + shared (user_id = 'shared') + project-wide (user_id = 'sifututor')
export async function memorySearch(
  db: Database.Database,
  userId: string,
  input: MemorySearchInput
): Promise<MemorySearchResult[]> {
  const limit = input.limit ?? 10;

  const [ftsResults, vecResults] = await Promise.all([
    Promise.resolve(ftsSearch(db, input.query, { category: input.category, tags: input.tags, limit, userId })),
    vectorSearch(db, input.query, limit, userId).catch(() => []),
  ]);

  // Collect metadata (recency + signal weighting) before blending
  const allIds = [...new Set([...ftsResults.map(r => r.id), ...vecResults.map(r => r.id)])];
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

  // Use the same blender as memory_context — FTS + vector weighted, deduped, recency + signal boosted
  const blended = blendResults(ftsResults, vecResults, [], limit, metaMap);

  const results: MemorySearchResult[] = [];

  for (const blend of blended) {
    const enriched = enrichMemory(db, blend.id, userId);
    if (!enriched) continue;
    const source: MemorySearchResult['source'] =
      blend.sources.fts !== undefined && blend.sources.vector !== undefined
        ? 'blended'
        : blend.sources.fts !== undefined
        ? 'fts'
        : 'vector';
    results.push({ ...enriched, score: blend.score, source });
  }

  const updateAccess = db.prepare(
    'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of results) updateAccess.run(now, r.id);
  })();

  return results;
}

function enrichMemory(
  db: Database.Database,
  id: string,
  userId: string
): Omit<MemorySearchResult, 'score' | 'source'> | null {
  const memory = db.prepare(
    'SELECT content, why, category FROM memories WHERE id = ? AND (user_id = ? OR user_id = ? OR user_id = ?) AND superseded_at IS NULL'
  ).get(id, userId, 'shared', 'sifututor') as { content: string; why: string | null; category: string } | undefined;

  if (!memory) return null;

  const tags = db.prepare('SELECT tag FROM tags WHERE memory_id = ?').all(id) as { tag: string }[];

  return {
    id,
    content: memory.content,
    why: memory.why,
    category: memory.category ?? 'unknown',
    tags: tags.map((t) => t.tag),
  };
}
