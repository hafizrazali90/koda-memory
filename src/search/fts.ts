import type Database from 'better-sqlite3';

export interface FtsResult {
  id: string;
  content: string;
  why: string | null;
  tags: string;
  score: number; // BM25 score (lower = more relevant, we normalize later)
}

/**
 * Full-text search using FTS5 with BM25 ranking.
 * Supports phrase queries ("exact phrase"), prefix matching (pay*), and boolean operators (OR).
 */
export function ftsSearch(
  db: Database.Database,
  query: string,
  options?: {
    category?: string;
    tags?: string[];
    limit?: number;
  }
): FtsResult[] {
  const limit = options?.limit ?? 20;

  // Sanitize query for FTS5 - escape special chars, preserve phrases and prefixes
  const ftsQuery = sanitizeFtsQuery(query);

  if (!ftsQuery.trim()) {
    return [];
  }

  let sql = `
    SELECT
      f.id,
      f.content,
      f.why,
      f.tags,
      bm25(memories_fts, 0, 10, 5, 3) as score
    FROM memories_fts f
    WHERE memories_fts MATCH ?
  `;

  const params: any[] = [ftsQuery];

  // Filter by category if provided (join with memories table)
  if (options?.category) {
    sql = `
      SELECT
        f.id,
        f.content,
        f.why,
        f.tags,
        bm25(memories_fts, 0, 10, 5, 3) as score
      FROM memories_fts f
      JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH ?
        AND m.category = ?
    `;
    params.push(options.category);
  }

  // Filter by tags if provided
  if (options?.tags && options.tags.length > 0) {
    const tagPlaceholders = options.tags.map(() => '?').join(', ');
    if (options?.category) {
      sql += `\n        AND f.id IN (SELECT memory_id FROM tags WHERE tag IN (${tagPlaceholders}))`;
    } else {
      sql = `
        SELECT
          f.id,
          f.content,
          f.why,
          f.tags,
          bm25(memories_fts, 0, 10, 5, 3) as score
        FROM memories_fts f
        WHERE memories_fts MATCH ?
          AND f.id IN (SELECT memory_id FROM tags WHERE tag IN (${tagPlaceholders}))
      `;
    }
    params.push(...options.tags);
  }

  sql += `\n    ORDER BY score\n    LIMIT ?`;
  params.push(limit);

  try {
    return db.prepare(sql).all(...params) as FtsResult[];
  } catch {
    // If FTS query syntax fails, try a simpler query
    return simpleFtsSearch(db, query, limit);
  }
}

/**
 * Sanitize user query for FTS5 syntax.
 * - Preserves quoted phrases: "exact match"
 * - Preserves prefix wildcards: pay*
 * - Wraps bare words so they work with FTS5
 */
function sanitizeFtsQuery(query: string): string {
  // If query contains quotes, preserve phrase search
  if (query.includes('"')) {
    return query;
  }

  // Split into words and join with implicit AND
  const words = query
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((word) => {
      // Preserve prefix wildcards
      if (word.endsWith('*')) {
        return word;
      }
      // Remove FTS5 special characters from bare words
      return word.replace(/[{}()\[\]^~:!@#$%&]/g, '');
    })
    .filter((w) => w.length > 0);

  return words.join(' ');
}

/**
 * Fallback search: wrap each word as a prefix match.
 */
function simpleFtsSearch(db: Database.Database, query: string, limit: number): FtsResult[] {
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];

  // Use OR between prefix-matched words for a lenient fallback
  const ftsQuery = words.map((w) => `${w.replace(/[^a-zA-Z0-9]/g, '')}*`).join(' OR ');

  try {
    return db
      .prepare(
        `SELECT id, content, why, tags, bm25(memories_fts, 0, 10, 5, 3) as score
         FROM memories_fts
         WHERE memories_fts MATCH ?
         ORDER BY score
         LIMIT ?`
      )
      .all(ftsQuery, limit) as FtsResult[];
  } catch {
    return [];
  }
}
