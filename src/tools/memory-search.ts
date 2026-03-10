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

export async function memorySearch(db: Database.Database, input: MemorySearchInput): Promise<MemorySearchResult[]> {
  const limit = input.limit ?? 10;

  // Run FTS5 and vector search in parallel
  const [ftsResults, vecResults] = await Promise.all([
    Promise.resolve(
      ftsSearch(db, input.query, {
        category: input.category,
        tags: input.tags,
        limit,
      })
    ),
    vectorSearch(db, input.query, limit).catch(() => []),
  ]);

  // Build results map to deduplicate
  const resultMap = new Map<string, MemorySearchResult>();

  // Add FTS results
  for (const fts of ftsResults) {
    const enriched = enrichMemory(db, fts.id, fts.content, fts.why);
    resultMap.set(fts.id, {
      ...enriched,
      score: fts.score,
      source: 'fts',
    });
  }

  // Add vector results (skip duplicates, or upgrade if vector score is better)
  for (const vec of vecResults) {
    if (!resultMap.has(vec.id)) {
      const memory = db.prepare('SELECT content, why FROM memories WHERE id = ?').get(vec.id) as
        | { content: string; why: string | null }
        | undefined;
      if (memory) {
        const enriched = enrichMemory(db, vec.id, memory.content, memory.why);
        resultMap.set(vec.id, {
          ...enriched,
          score: vec.score,
          source: 'vector',
        });
      }
    }
  }

  const results = Array.from(resultMap.values()).slice(0, limit);

  // Update access tracking
  const updateAccess = db.prepare(
    'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of results) {
      updateAccess.run(now, r.id);
    }
  })();

  return results;
}

function enrichMemory(
  db: Database.Database,
  id: string,
  content: string,
  why: string | null
): Omit<MemorySearchResult, 'score' | 'source'> {
  const memory = db.prepare('SELECT category FROM memories WHERE id = ?').get(id) as
    | { category: string }
    | undefined;
  const tags = db.prepare('SELECT tag FROM tags WHERE memory_id = ?').all(id) as { tag: string }[];

  return {
    id,
    content,
    why,
    category: memory?.category ?? 'unknown',
    tags: tags.map((t) => t.tag),
  };
}
