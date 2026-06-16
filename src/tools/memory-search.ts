import type Database from 'better-sqlite3';
import { ftsSearch } from '../search/fts.js';
import { vectorSearch } from '../search/vector.js';

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

// userId sees their own memories + shared (user_id = 'shared') team memories
export async function memorySearch(
  db: Database.Database,
  userId: string,
  input: MemorySearchInput
): Promise<MemorySearchResult[]> {
  const limit = input.limit ?? 10;

  const [ftsResults, vecResults] = await Promise.all([
    Promise.resolve(ftsSearch(db, input.query, { category: input.category, tags: input.tags, limit })),
    vectorSearch(db, input.query, limit).catch(() => []),
  ]);

  const resultMap = new Map<string, MemorySearchResult>();

  for (const fts of ftsResults) {
    const enriched = enrichMemory(db, fts.id, fts.content, fts.why, userId);
    if (!enriched) continue;
    resultMap.set(fts.id, { ...enriched, score: fts.score, source: 'fts' });
  }

  for (const vec of vecResults) {
    if (!resultMap.has(vec.id)) {
      const memory = db.prepare(
        'SELECT content, why FROM memories WHERE id = ? AND (user_id = ? OR user_id = ?)'
      ).get(vec.id, userId, 'shared') as { content: string; why: string | null } | undefined;
      if (memory) {
        const enriched = enrichMemory(db, vec.id, memory.content, memory.why, userId);
        if (enriched) resultMap.set(vec.id, { ...enriched, score: vec.score, source: 'vector' });
      }
    }
  }

  const results = Array.from(resultMap.values()).slice(0, limit);

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
  content: string,
  why: string | null,
  userId: string
): Omit<MemorySearchResult, 'score' | 'source'> | null {
  const memory = db.prepare(
    'SELECT category FROM memories WHERE id = ? AND (user_id = ? OR user_id = ?)'
  ).get(id, userId, 'shared') as { category: string } | undefined;

  if (!memory) return null;

  const tags = db.prepare('SELECT tag FROM tags WHERE memory_id = ?').all(id) as { tag: string }[];

  return {
    id, content, why,
    category: memory.category ?? 'unknown',
    tags: tags.map((t) => t.tag),
  };
}
