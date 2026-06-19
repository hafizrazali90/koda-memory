import type Database from 'better-sqlite3';
import { ftsSearch } from '../search/fts.js';
import { createRelationship } from '../search/graph.js';
import type { ContradictionResult } from './types.js';

const MAX_CANDIDATES = 3;

interface MemoryRow {
  id: string;
  content: string;
  why: string | null;
  project: string;
  user_id: string;
  conflicts_with: string | null;
}

/**
 * Ask Claude Haiku whether two statements contradict each other.
 * Returns true if the model answers YES.
 */
async function askLlmIsContradiction(contentA: string, contentB: string): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[contradiction-detector] OPENAI_API_KEY not set — skipping LLM contradiction check');
    return false;
  }

  const prompt =
    `Statement A:\n"${contentA}"\n\nStatement B:\n"${contentB}"\n\n` +
    `Do these two statements contradict each other? Answer YES or NO only.`;

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
    console.warn('[contradiction-detector] LLM call failed:', (err as Error).message);
    return false;
  }
}

/**
 * Append a contradicting memory ID to the `conflicts_with` column (comma-separated).
 * Avoids duplicate entries.
 */
function appendConflict(db: Database.Database, memoryId: string, conflictingId: string): void {
  const row = db
    .prepare('SELECT conflicts_with FROM memories WHERE id = ?')
    .get(memoryId) as { conflicts_with: string | null } | undefined;

  if (!row) return;

  const existing = row.conflicts_with ? row.conflicts_with.split(',').map((s) => s.trim()) : [];
  if (existing.includes(conflictingId)) return; // already recorded

  const updated = [...existing, conflictingId].join(',');
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE memories SET conflicts_with = ?, validation_checked_at = ? WHERE id = ?'
  ).run(updated, now, memoryId);
}

/**
 * Detect whether the given memory contradicts any existing memory visible to the caller.
 *
 * Strategy:
 *   1. Load the memory's content + tags.
 *   2. Collect candidates via:
 *      a. Memories already in a 'contradicts' relationship with this memory.
 *      b. Near-FTS matches in the same project (limit 3, exclude self).
 *   3. For each candidate (up to MAX_CANDIDATES): ask Claude Haiku.
 *   4. On first confirmed contradiction:
 *      - Append conflicting ID to `conflicts_with` on both memories.
 *      - Create a 'contradicts' graph relationship.
 *   5. Return the first contradiction found (or no contradiction).
 */
export async function detectContradiction(
  db: Database.Database,
  memoryId: string,
  userId: string
): Promise<ContradictionResult> {
  const memory = db
    .prepare(
      `SELECT id, content, why, project, user_id, conflicts_with
       FROM memories
       WHERE id = ? AND deleted_at IS NULL`
    )
    .get(memoryId) as MemoryRow | undefined;

  if (!memory) {
    return { contradicts: false };
  }

  // --- Build candidate set ---
  const candidateIds = new Set<string>();

  // a. Memories already connected with 'contradicts' relationship
  const existingContradicts = db
    .prepare(
      `SELECT source_id, target_id FROM relationships
       WHERE relation_type = 'contradicts'
         AND (source_id = ? OR target_id = ?)`
    )
    .all(memoryId, memoryId) as { source_id: string; target_id: string }[];

  for (const rel of existingContradicts) {
    const otherId = rel.source_id === memoryId ? rel.target_id : rel.source_id;
    if (otherId !== memoryId) candidateIds.add(otherId);
  }

  // b. FTS near-matches in the caller's visible scope
  const ftsResults = ftsSearch(db, memory.content, {
    limit: MAX_CANDIDATES * 2, // over-fetch then cap
    userId,
    operator: 'OR',
  }).filter((r) => r.id !== memoryId);

  for (const r of ftsResults.slice(0, MAX_CANDIDATES)) {
    candidateIds.add(r.id);
  }

  if (candidateIds.size === 0) {
    db.prepare(
      'UPDATE memories SET validation_checked_at = ? WHERE id = ? AND deleted_at IS NULL'
    ).run(new Date().toISOString(), memoryId);
    return { contradicts: false };
  }

  // --- Check each candidate via LLM ---
  const candidates = Array.from(candidateIds).slice(0, MAX_CANDIDATES);

  for (const candidateId of candidates) {
    const candidate = db
      .prepare(
        'SELECT id, content FROM memories WHERE id = ? AND deleted_at IS NULL'
      )
      .get(candidateId) as { id: string; content: string } | undefined;

    if (!candidate) continue;

    const isContradiction = await askLlmIsContradiction(memory.content, candidate.content);

    if (isContradiction) {
      // Record on both sides
      appendConflict(db, memoryId, candidateId);
      appendConflict(db, candidateId, memoryId);

      // Create graph relationship (createRelationship is idempotent via INSERT OR IGNORE)
      try {
        createRelationship(db, memoryId, candidateId, 'contradicts');
      } catch {
        // Relationship may already exist — not fatal
      }

      return {
        contradicts: true,
        conflicting_id: candidateId,
        reason: `LLM confirmed contradiction between ${memoryId} and ${candidateId}`,
      };
    }
  }

  // No contradiction found — still stamp the checked_at
  db.prepare(
    'UPDATE memories SET validation_checked_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), memoryId);

  return { contradicts: false };
}
