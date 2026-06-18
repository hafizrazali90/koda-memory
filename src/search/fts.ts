import type Database from 'better-sqlite3';

export interface FtsResult {
  id: string;
  content: string;
  why: string | null;
  tags: string;
  score: number; // BM25 score (lower = more relevant, we normalize later)
}

// Grammatical stop words only — deliberately excludes technical terms like
// 'not', 'no', 'working', 'up', 'out', 'if' which are meaningful in dev queries
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'i', 'we', 'you',
  'he', 'she', 'it', 'they', 'this', 'that', 'these', 'those', 'am',
]);

/**
 * Full-text search using FTS5 with BM25 ranking.
 * Supports phrase queries ("exact phrase"), prefix matching (pay*), and OR mode.
 */
export function ftsSearch(
  db: Database.Database,
  query: string,
  options?: {
    category?: string;
    tags?: string[];
    limit?: number;
    operator?: 'AND' | 'OR';
    userId?: string;
  }
): FtsResult[] {
  const limit = options?.limit ?? 20;
  const operator = options?.operator ?? 'AND';

  // Sanitize query for FTS5
  const ftsQuery = sanitizeFtsQuery(query, operator);

  if (!ftsQuery.trim()) {
    return [];
  }

  // Build WHERE clauses incrementally. JOIN memories only when we need a
  // column from it (visibility or category filter).
  const conditions: string[] = ['memories_fts MATCH ?'];
  const params: any[] = [ftsQuery];
  let joinMemories = false;

  // Visibility: caller's own + shared + project-wide (sifututor). Filtered here
  // in SQL (before LIMIT) so the search yields a full page of visible results.
  if (options?.userId) {
    joinMemories = true;
    conditions.push("(m.user_id = ? OR m.user_id = 'shared' OR m.user_id = 'sifututor')");
    params.push(options.userId);
  }

  if (options?.category) {
    joinMemories = true;
    conditions.push('m.category = ?');
    params.push(options.category);
  }

  if (options?.tags && options.tags.length > 0) {
    const tagPlaceholders = options.tags.map(() => '?').join(', ');
    conditions.push(`f.id IN (SELECT memory_id FROM tags WHERE tag IN (${tagPlaceholders}))`);
    params.push(...options.tags);
  }

  const sql = `
    SELECT
      f.id,
      f.content,
      f.why,
      f.tags,
      bm25(memories_fts, 0, 10, 5, 3) as score
    FROM memories_fts f
    ${joinMemories ? 'JOIN memories m ON m.id = f.id' : ''}
    WHERE ${conditions.join(' AND ')}
    ORDER BY score
    LIMIT ?`;
  params.push(limit);

  try {
    return db.prepare(sql).all(...params) as FtsResult[];
  } catch {
    // If FTS query syntax fails, try a simpler query
    return simpleFtsSearch(db, query, limit, options?.userId);
  }
}

/**
 * Sanitize user query for FTS5 syntax.
 * - Preserves quoted phrases: "exact match"
 * - Preserves prefix wildcards: pay*
 * - Strips stop words for better matching
 * - Joins with AND (default) or OR
 */
function sanitizeFtsQuery(query: string, operator: 'AND' | 'OR' = 'AND'): string {
  // If query contains quotes, preserve phrase search
  if (query.includes('"')) {
    return query;
  }

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
    .filter((w) => w.length > 0)
    // Strip stop words (unless it's the only word)
    .filter((w) => !STOP_WORDS.has(w.toLowerCase().replace(/\*$/, '')));

  if (words.length === 0) {
    // All words were stop words — fall back to original without filtering
    const fallback = query
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => w.replace(/[{}()\[\]^~:!@#$%&]/g, ''))
      .filter((w) => w.length > 0);
    return fallback.join(` ${operator} `);
  }

  return words.join(operator === 'OR' ? ' OR ' : ' ');
}

/**
 * Fallback search: wrap each word as a prefix match with OR.
 */
function simpleFtsSearch(db: Database.Database, query: string, limit: number, userId?: string): FtsResult[] {
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];

  const ftsQuery = words
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()))
    .map((w) => `${w.replace(/[^a-zA-Z0-9]/g, '')}*`)
    .filter((w) => w.length > 1)
    .join(' OR ');

  if (!ftsQuery) return [];

  const params: any[] = [ftsQuery];
  const userFilter = userId
    ? "JOIN memories m ON m.id = f.id WHERE memories_fts MATCH ? AND (m.user_id = ? OR m.user_id = 'shared' OR m.user_id = 'sifututor')"
    : 'WHERE memories_fts MATCH ?';
  if (userId) params.push(userId);
  params.push(limit);

  try {
    return db
      .prepare(
        `SELECT f.id, f.content, f.why, f.tags, bm25(memories_fts, 0, 10, 5, 3) as score
         FROM memories_fts f
         ${userFilter}
         ORDER BY score
         LIMIT ?`
      )
      .all(...params) as FtsResult[];
  } catch {
    return [];
  }
}
