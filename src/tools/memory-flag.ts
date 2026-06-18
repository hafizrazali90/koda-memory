import type Database from 'better-sqlite3';

export interface MemoryFlagInput {
  id: string;
  reason?: string;
  clear?: boolean;
}

export interface MemoryFlagResult {
  id: string;
  flagged: boolean;
  message: string;
}

/**
 * Flag (or unflag) a memory as potentially outdated.
 *
 * Unlike memory_update/memory_forget, this has NO ownership check — any
 * authenticated user can flag any memory they can see (their own + shared +
 * project-wide 'sifututor'). This is the governance path for shared project
 * memories that no single user owns. Flagging does NOT delete the memory or
 * change its confidence; it only records who raised the concern and when, so
 * the memory surfaces in project_health for a human to review.
 */
export function memoryFlag(db: Database.Database, userId: string, input: MemoryFlagInput): MemoryFlagResult {
  // Only memories the caller can actually see may be flagged
  const existing = db.prepare(
    `SELECT id FROM memories WHERE id = ?
       AND (user_id = ? OR user_id = 'shared' OR user_id = 'sifututor')`
  ).get(input.id, userId);
  if (!existing) {
    throw new Error(`Memory ${input.id} not found or not visible to user '${userId}'`);
  }

  const now = new Date().toISOString();

  if (input.clear) {
    db.prepare(
      'UPDATE memories SET flagged_outdated_by = NULL, flagged_outdated_at = NULL WHERE id = ?'
    ).run(input.id);
    return {
      id: input.id,
      flagged: false,
      message: `Cleared outdated flag on ${input.id}`,
    };
  }

  db.prepare(
    'UPDATE memories SET flagged_outdated_by = ?, flagged_outdated_at = ? WHERE id = ?'
  ).run(userId, now, input.id);

  return {
    id: input.id,
    flagged: true,
    message: `Flagged ${input.id} as potentially outdated${input.reason ? ` — ${input.reason}` : ''}. It remains stored and searchable until a human reviews it.`,
  };
}
