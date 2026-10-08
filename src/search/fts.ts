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
    project?: string;
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
  // column from it (visibility or category filter). CROSS JOIN keeps the FTS
  // index as the outer loop: with production statistics SQLite otherwise
  // walked memories by user_id and re-ran MATCH per row (08/10/2026 outage).
  const conditions: string[] = ['memories_fts MATCH ?'];
  const params: any[] = [ftsQuery];
  let joinMemories = false;

  // Visibility: caller's own + shared + project-wide (sifututor). Filtered here
  // in SQL (before LIMIT) so the search yields a full page of visible results.
  // Superseded memories are excluded — their facts have been replaced.
  if (options?.userId) {
    joinMemories = true;
    conditions.push("(m.user_id = ? OR m.user_id = 'shared' OR m.user_id = 'sifututor')");
    conditions.push('m.superseded_at IS NULL');
    params.push(options.userId);
  }

  if (options?.category) {
    joinMemories = true;
    conditions.push('m.category = ?');
    params.push(options.category);
  }

  if (options?.project) {
    joinMemories = true;
    conditions.push('m.project = ?');
    params.push(options.project);
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
    ${joinMemories ? 'CROSS JOIN memories m ON m.id = f.id' : ''}
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

/** Upper bound on generated FTS terms; long memory text must stay cheap. */
export const MAX_QUERY_TERMS = 24;
/** Auto-generated prefix terms shorter than this expand to too many tokens. */
const MIN_AUTO_PREFIX_LENGTH = 4;
/** A query with quotes is kept verbatim only when it is a short user search. */
const MAX_VERBATIM_PHRASE_QUERY = 200;

/** FTS5 tokens of a word: letters, digits and underscore runs. */
function tokensOf(text: string): string[] {
  return text.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0);
}

/** Keeps the first occurrence of each term (case-insensitive), up to the cap. */
function capUnique(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

/**
 * Sanitize a query for FTS5 syntax.
 * - Keeps a short quoted user search verbatim: "exact match"
 * - Keeps an explicit user prefix: pay*
 * - Every other word becomes a quoted phrase of its tokens, so punctuation
 *   (hyphens, slashes, dots, apostrophes) can never break the FTS5 syntax
 * - Strips stop words, de-duplicates, caps the number of terms
 * - Joins with AND (default) or OR
 *
 * 08/10/2026: memory text with punctuation used to produce invalid syntax,
 * which fell back to a prefix-per-word query that froze the server.
 */
export function sanitizeFtsQuery(query: string, operator: 'AND' | 'OR' = 'AND'): string {
  if (query.includes('"') && operator === 'AND' && query.length <= MAX_VERBATIM_PHRASE_QUERY) {
    return query;
  }

  const build = (dropStopWords: boolean): string[] =>
    capUnique(
      query
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .flatMap((word): string[] => {
          if (word.endsWith('*') && operator === 'AND') {
            const stem = tokensOf(word.slice(0, -1));
            return stem.length === 1 && stem[0].length >= 2 ? [`${stem[0]}*`] : [];
          }
          const tokens = tokensOf(word).filter(
            (t) => !dropStopWords || !STOP_WORDS.has(t.toLowerCase())
          );
          return tokens.length > 0 ? [`"${tokens.join(' ')}"`] : [];
        })
    );

  let terms = build(true);
  if (terms.length === 0) terms = build(false);
  return terms.join(operator === 'OR' ? ' OR ' : ' ');
}

/**
 * Fallback FTS query: distinct tokens, prefix-matched only when long enough,
 * capped. Never emits short prefix stubs such as `a*`.
 */
export function buildFallbackFtsQuery(query: string): string {
  return capUnique(
    tokensOf(query)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t.toLowerCase()))
      .map((t) => (t.length >= MIN_AUTO_PREFIX_LENGTH ? `${t}*` : `"${t}"`))
  ).join(' OR ');
}

/**
 * Fallback search over buildFallbackFtsQuery (bounded, no short prefix stubs).
 */
function simpleFtsSearch(db: Database.Database, query: string, limit: number, userId?: string): FtsResult[] {
  const ftsQuery = buildFallbackFtsQuery(query);

  if (!ftsQuery) return [];

  const params: any[] = [ftsQuery];
  const userFilter = userId
    ? "CROSS JOIN memories m ON m.id = f.id WHERE memories_fts MATCH ? AND (m.user_id = ? OR m.user_id = 'shared' OR m.user_id = 'sifututor') AND m.superseded_at IS NULL"
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
