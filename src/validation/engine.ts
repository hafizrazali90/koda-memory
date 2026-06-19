import type Database from 'better-sqlite3';
import { enqueueValidation, dequeueJobs, markDone, markFailed } from './queue.js';
import { detectDuplicate } from './duplicate-detector.js';
import { detectContradiction } from './contradiction-detector.js';
import { applyStalenessDcay } from './staleness-decay.js';
import type { ValidationJob } from './types.js';

export interface BatchResult {
  processed: number;
  duplicates: number;
  contradictions: number;
  errors: number;
}

/**
 * Enqueue all three validation job types for a freshly stored memory.
 * Should be called after memory_store succeeds — wrapped in try/catch by the caller.
 */
export function scheduleValidation(
  db: Database.Database,
  memoryId: string,
  _userId: string
): void {
  enqueueValidation(db, memoryId, 'duplicate_check');
  enqueueValidation(db, memoryId, 'contradiction_check');
  enqueueValidation(db, memoryId, 'staleness_decay');
}

/**
 * Process a single validation job and return whether it was a positive detection.
 */
async function processJob(
  db: Database.Database,
  job: ValidationJob,
  userId: string
): Promise<{ detected: boolean }> {
  switch (job.job_type) {
    case 'duplicate_check': {
      const result = await detectDuplicate(db, job.memory_id, userId);
      return { detected: result.is_duplicate };
    }

    case 'contradiction_check': {
      const result = await detectContradiction(db, job.memory_id, userId);
      return { detected: result.contradicts };
    }

    case 'staleness_decay': {
      // staleness_decay is global — runs once per job but processes all eligible memories
      const count = applyStalenessDcay(db);
      return { detected: count > 0 };
    }

    default: {
      throw new Error(`Unknown job type: ${(job as ValidationJob).job_type}`);
    }
  }
}

/**
 * Run one batch of validation jobs from the queue.
 *
 * 1. Dequeue up to `batchSize` pending jobs (atomically marked as 'processing').
 * 2. For each job, dispatch to the appropriate detector.
 * 3. Mark done or failed based on outcome.
 * 4. Return a summary of the batch.
 *
 * NOTE: This runs asynchronously. It must NOT be awaited on the hot path of
 * MCP tool calls — fire-and-forget from memory_store.
 */
export async function runValidationBatch(
  db: Database.Database,
  userId: string,
  batchSize: number = 10
): Promise<BatchResult> {
  const jobs = dequeueJobs(db, batchSize);

  const result: BatchResult = {
    processed: 0,
    duplicates: 0,
    contradictions: 0,
    errors: 0,
  };

  for (const job of jobs) {
    try {
      const { detected } = await processJob(db, job, userId);
      markDone(db, job.id);
      result.processed++;

      if (detected) {
        if (job.job_type === 'duplicate_check') result.duplicates++;
        if (job.job_type === 'contradiction_check') result.contradictions++;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      markFailed(db, job.id, errorMsg);
      result.errors++;
    }
  }

  return result;
}
