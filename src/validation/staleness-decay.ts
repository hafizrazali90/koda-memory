import type Database from 'better-sqlite3';

const STALENESS_DAYS = 90;
const STALENESS_MAX_ACCESS = 3;

/**
 * Apply staleness decay: mark inferred memories as 'outdated' when they are
 * low-confidence and have not been actively used.
 *
 * Criteria:
 *   - confidence = 'inferred'  (human hasn't confirmed it)
 *   - last_accessed < 90 days ago  (nobody has looked at it recently)
 *   - access_count < 3  (never gained traction)
 *   - not already deleted or superseded
 *
 * Returns the count of memories that were marked outdated.
 */
export function applyStalenessDcay(db: Database.Database): number {
  const cutoff = new Date(Date.now() - STALENESS_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = db
    .prepare(
      `UPDATE memories
       SET confidence = 'outdated',
           validation_checked_at = datetime('now')
       WHERE confidence = 'inferred'
         AND (last_accessed IS NULL OR last_accessed < ?)
         AND (access_count IS NULL OR access_count < ?)
         AND deleted_at IS NULL
         AND superseded_at IS NULL`
    )
    .run(cutoff, STALENESS_MAX_ACCESS);

  return result.changes;
}
