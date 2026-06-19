import type Database from 'better-sqlite3';
import type { ValidationJob } from './types.js';

/**
 * Enqueue a new validation job for a memory.
 * Inserts with status='pending'. Silently ignores if an identical pending/processing job exists.
 */
export function enqueueValidation(
  db: Database.Database,
  memoryId: string,
  jobType: ValidationJob['job_type']
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO validation_queue (memory_id, job_type, status, attempts, created_at)
    VALUES (?, ?, 'pending', 0, ?)
  `).run(memoryId, jobType, now);
}

/**
 * Atomically claim up to `limit` pending jobs: flip status to 'processing', return them.
 * Uses a transaction + SELECT + UPDATE to avoid race conditions under concurrent readers.
 */
export function dequeueJobs(db: Database.Database, limit: number = 10): ValidationJob[] {
  const now = new Date().toISOString();
  const jobs = db.transaction((): ValidationJob[] => {
    // Only claim jobs whose backoff window has elapsed (next_attempt_at NULL or past).
    const rows = db.prepare(`
      SELECT id, memory_id, job_type, status, attempts, last_error, created_at, processed_at, next_attempt_at
      FROM validation_queue
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(now, limit) as ValidationJob[];

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(`
      UPDATE validation_queue SET status = 'processing' WHERE id IN (${placeholders})
    `).run(...ids);

    return rows.map((r) => ({ ...r, status: 'processing' as const }));
  })();

  return jobs;
}

/**
 * Mark a job as successfully completed.
 */
export function markDone(db: Database.Database, jobId: number): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE validation_queue SET status = 'done', processed_at = ? WHERE id = ?
  `).run(now, jobId);
}

// A job is retried up to MAX_ATTEMPTS times with exponential backoff before it
// is dead-lettered (status='failed'). Transient LLM/network errors should not
// permanently drop a memory's validation.
export const MAX_ATTEMPTS = 4;

/**
 * Record a job failure.
 *
 * If the job has attempts left, it is re-queued as 'pending' with an
 * exponential backoff (next_attempt_at = now + 2^attempts minutes). Once
 * MAX_ATTEMPTS is reached it is dead-lettered as 'failed' so it stops retrying.
 */
export function markFailed(db: Database.Database, jobId: number, error: string): void {
  const now = new Date();
  const row = db.prepare('SELECT attempts FROM validation_queue WHERE id = ?').get(jobId) as
    | { attempts: number }
    | undefined;
  const attempts = (row?.attempts ?? 0) + 1;

  if (attempts < MAX_ATTEMPTS) {
    // Backoff: 2, 4, 8 minutes for attempts 1, 2, 3.
    const delayMs = Math.pow(2, attempts) * 60_000;
    const nextAttemptAt = new Date(now.getTime() + delayMs).toISOString();
    db.prepare(`
      UPDATE validation_queue
      SET status = 'pending', last_error = ?, attempts = ?, next_attempt_at = ?
      WHERE id = ?
    `).run(error, attempts, nextAttemptAt, jobId);
  } else {
    db.prepare(`
      UPDATE validation_queue
      SET status = 'failed', last_error = ?, attempts = ?, processed_at = ?
      WHERE id = ?
    `).run(error, attempts, now.toISOString(), jobId);
  }
}

/**
 * Return the count of jobs currently waiting to be processed.
 */
export function getQueueDepth(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM validation_queue WHERE status = 'pending'"
  ).get() as { cnt: number };
  return row.cnt;
}
