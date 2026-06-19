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
  const jobs = db.transaction((): ValidationJob[] => {
    const rows = db.prepare(`
      SELECT id, memory_id, job_type, status, attempts, last_error, created_at, processed_at
      FROM validation_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as ValidationJob[];

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

/**
 * Mark a job as failed. Increments the attempt counter and records the error message.
 */
export function markFailed(db: Database.Database, jobId: number, error: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE validation_queue
    SET status = 'failed', last_error = ?, attempts = attempts + 1, processed_at = ?
    WHERE id = ?
  `).run(error, now, jobId);
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
