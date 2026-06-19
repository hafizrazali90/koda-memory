import type Database from 'better-sqlite3';
import { ftsSearch } from '../search/fts.js';
import { createRelationship } from '../search/graph.js';
import { embeddingSimilarity } from '../search/vector.js';
import { isEmbeddingAvailable } from '../embeddings/openai.js';
import { askYesNo, isClassifierAvailable } from '../llm/classifier.js';
import type { DuplicateResult } from './types.js';

// FTS score threshold to call LLM for confirmation (normalised 0-1, higher = more similar)
const FTS_LLM_THRESHOLD = 0.85;

// Vector cosine pre-filter: only ask the LLM when the top FTS candidate is also
// semantically close. normaliseBm25 makes the top FTS hit ~1.0 for almost any
// memory, so without this gate we'd call the LLM for nearly every memory. The
// embedding similarity is the cheap, reliable signal that two memories are
// actually about the same thing.
const VECTOR_PREFILTER_THRESHOLD = 0.85;

interface MemoryRow {
  id: string;
  content: string;
  why: string | null;
  project: string;
  user_id: string;
}

/**
 * Normalise FTS BM25 scores (negative, more-negative = better) to 0-1 similarity.
 * Returns 0-1 where 1 = most similar.
 */
function normaliseBm25(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores); // most-negative = best
  const max = Math.max(...scores); // least-negative = worst
  const range = max - min;
  return scores.map((s) => (range === 0 ? 1.0 : (max - s) / range));
}

/**
 * Ask the configured LLM whether two memory strings say the same thing.
 * Throws on API failure (so the job retries) — never silently returns false.
 */
async function askLlmIsDuplicate(contentA: string, contentB: string): Promise<boolean> {
  return askYesNo(
    `Memory A:\n"${contentA}"\n\nMemory B:\n"${contentB}"\n\n` +
      `Are these two memories saying the same thing?`
  );
}

/**
 * Detect whether the given memory is a duplicate of an existing one.
 *
 * Strategy:
 *   1. Load the memory's content + project.
 *   2. FTS search within the same project (limit 5, exclude self).
 *   3. Vector pre-filter: require the top FTS candidate to be semantically close
 *      (embedding cosine >= VECTOR_PREFILTER_THRESHOLD) before spending an LLM call.
 *   4. LLM confirmation is the final gate — a duplicate is only marked on YES.
 *   5. On confirmed duplicate: set duplicate_of + confidence='outdated' + a
 *      'supersedes' graph edge (canonical → duplicate).
 */
export async function detectDuplicate(
  db: Database.Database,
  memoryId: string,
  userId: string
): Promise<DuplicateResult> {
  const memory = db
    .prepare(
      `SELECT id, content, why, project, user_id
       FROM memories
       WHERE id = ? AND deleted_at IS NULL`
    )
    .get(memoryId) as MemoryRow | undefined;

  if (!memory) {
    return { is_duplicate: false };
  }

  // FTS search: same project, caller-visible scope, exclude self
  const ftsResults = ftsSearch(db, memory.content, {
    limit: 5,
    userId,
    operator: 'OR',
  }).filter((r) => r.id !== memoryId);

  if (ftsResults.length === 0) {
    return { is_duplicate: false };
  }

  // Normalise scores
  const rawScores = ftsResults.map((r) => r.score);
  const normScores = normaliseBm25(rawScores);

  const topScore = normScores[0] ?? 0;
  const topResult = ftsResults[0];

  // Decide whether we have a duplicate.
  //
  // A duplicate is ONLY ever confirmed by the LLM, and only after a cheap vector
  // pre-filter agrees the two are semantically close. FTS rank alone is unsafe
  // (normaliseBm25 makes the top hit ~1.0 for almost any memory), which wrongly
  // flagged 171 unrelated memories on 2026-06-19. Without an LLM provider we
  // record the check and leave the memory untouched.
  let isDuplicate = false;
  let similarityReason: string | undefined;

  if (topScore > FTS_LLM_THRESHOLD && isClassifierAvailable()) {
    // Vector pre-filter: skip the LLM unless embeddings agree they're close.
    // If embeddings are unavailable we can't pre-filter, so fall through to the LLM.
    let vectorOk = true;
    let vectorScore: number | null = null;
    if (isEmbeddingAvailable()) {
      vectorScore = embeddingSimilarity(db, memoryId, topResult.id);
      vectorOk = vectorScore === null || vectorScore >= VECTOR_PREFILTER_THRESHOLD;
    }

    if (vectorOk) {
      const candidate = db
        .prepare('SELECT content FROM memories WHERE id = ? AND deleted_at IS NULL')
        .get(topResult.id) as { content: string } | undefined;

      if (candidate) {
        isDuplicate = await askLlmIsDuplicate(memory.content, candidate.content);
        if (isDuplicate) {
          const vecPart = vectorScore !== null ? `, cosine ${vectorScore.toFixed(2)}` : '';
          similarityReason = `FTS ${topScore.toFixed(2)}${vecPart}, confirmed by LLM`;
        }
      }
    }
  } else if (topScore > FTS_LLM_THRESHOLD && !isClassifierAvailable()) {
    console.warn(
      `[duplicate-detector] no LLM provider — NOT auto-marking ${memoryId}; left for an LLM-backed run`
    );
  }

  if (isDuplicate && topResult) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE memories
      SET duplicate_of = ?, confidence = 'outdated', validation_checked_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(topResult.id, now, memoryId);

    // Record the dedup in the graph: the canonical memory supersedes the duplicate.
    // This makes deduplication visible as a link on the knowledge-graph view
    // (createRelationship is idempotent via INSERT OR IGNORE).
    try {
      createRelationship(db, topResult.id, memoryId, 'supersedes');
    } catch {
      // Relationship may already exist — not fatal
    }

    return {
      is_duplicate: true,
      duplicate_of: topResult.id,
      similarity_reason: similarityReason,
    };
  }

  // Record that we checked even if no duplicate found
  db.prepare(
    `UPDATE memories SET validation_checked_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(new Date().toISOString(), memoryId);

  return { is_duplicate: false };
}
