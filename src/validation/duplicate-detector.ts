import type Database from 'better-sqlite3';
import { ftsSearch } from '../search/fts.js';
import type { DuplicateResult } from './types.js';

// FTS score threshold to call LLM for confirmation (normalised 0-1, higher = more similar)
const FTS_LLM_THRESHOLD = 0.85;

// FTS-only threshold when LLM is unavailable — stricter to avoid false positives
const FTS_ONLY_THRESHOLD = 0.92;

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
 * Ask Claude Haiku whether two memory strings say the same thing.
 * Returns true if the model answers YES.
 */
async function askLlmIsDuplicate(contentA: string, contentB: string): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return false;
  }

  const prompt =
    `Memory A:\n"${contentA}"\n\nMemory B:\n"${contentB}"\n\n` +
    `Are these two memories saying the same thing? Answer YES or NO only.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = (await resp.json()) as { content?: Array<{ text?: string }> };
    const answer = data.content?.[0]?.text?.trim().toUpperCase() ?? '';
    return answer.startsWith('YES');
  } catch (err) {
    console.warn('[duplicate-detector] LLM call failed:', (err as Error).message);
    return false;
  }
}

/**
 * Detect whether the given memory is a duplicate of an existing one.
 *
 * Strategy:
 *   1. Load the memory's content + project.
 *   2. FTS search within the same project (limit 5, exclude self).
 *   3. Normalise BM25 scores; if top score > FTS_LLM_THRESHOLD AND API key is set,
 *      confirm via Claude Haiku.  Without API key, use stricter FTS_ONLY_THRESHOLD.
 *   4. On confirmed duplicate: UPDATE memories SET duplicate_of, confidence='outdated'.
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

  const llmAvailable = Boolean(process.env.OPENAI_API_KEY);

  // Decide whether we have a duplicate
  let isDuplicate = false;
  let similarityReason: string | undefined;

  if (topScore > FTS_LLM_THRESHOLD && llmAvailable) {
    const candidate = db
      .prepare('SELECT content FROM memories WHERE id = ? AND deleted_at IS NULL')
      .get(topResult.id) as { content: string } | undefined;

    if (candidate) {
      isDuplicate = await askLlmIsDuplicate(memory.content, candidate.content);
      if (isDuplicate) {
        similarityReason = `FTS score ${topScore.toFixed(2)} confirmed by LLM`;
      }
    }
  } else if (topScore > FTS_ONLY_THRESHOLD) {
    // High-confidence FTS match without LLM
    isDuplicate = true;
    similarityReason = `FTS score ${topScore.toFixed(2)} exceeds no-LLM threshold`;
  } else if (topScore > FTS_LLM_THRESHOLD && !llmAvailable) {
    console.warn(
      `[duplicate-detector] OPENAI_API_KEY not set — skipping LLM for memory ${memoryId} (FTS score ${topScore.toFixed(2)})`
    );
  }

  if (isDuplicate && topResult) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE memories
      SET duplicate_of = ?, confidence = 'outdated', validation_checked_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(topResult.id, now, memoryId);

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
