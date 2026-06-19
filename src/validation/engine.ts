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
 * Resolve the owner of a memory so duplicate/contradiction detection runs in
 * the correct visibility scope (the owner sees own + shared + sifututor).
 * Falls back to the caller's userId when the memory can't be found.
 */
function resolveMemoryOwner(db: Database.Database, memoryId: string, fallback: string): string {
  const row = db.prepare('SELECT user_id FROM memories WHERE id = ?').get(memoryId) as
    | { user_id?: string }
    | undefined;
  return row?.user_id ?? fallback;
}

/**
 * Process a single validation job and return whether it was a positive detection.
 *
 * Duplicate + contradiction checks run in the memory OWNER's visibility scope,
 * not the caller's — so the background scheduler (which has no single user)
 * still searches the correct set of memories for each job.
 */
async function processJob(
  db: Database.Database,
  job: ValidationJob,
  fallbackUserId: string
): Promise<{ detected: boolean }> {
  switch (job.job_type) {
    case 'duplicate_check': {
      const owner = resolveMemoryOwner(db, job.memory_id, fallbackUserId);
      const result = await detectDuplicate(db, job.memory_id, owner);
      return { detected: result.is_duplicate };
    }

    case 'contradiction_check': {
      const owner = resolveMemoryOwner(db, job.memory_id, fallbackUserId);
      const result = await detectContradiction(db, job.memory_id, owner);
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

/**
 * Start a background scheduler that drains the validation queue on an interval.
 *
 * This is what makes validation AUTOMATIC — without it, jobs pile up forever
 * because runValidationBatch only ran on a manual MCP / dashboard trigger.
 *
 * Config (env, all optional):
 *   KODA_VALIDATION_INTERVAL_MS  — how often to run a batch (default 60000 = 60s)
 *   KODA_VALIDATION_BATCH_SIZE   — jobs per batch (default 5)
 *   KODA_VALIDATION_DISABLED     — set to '1' to turn the scheduler off entirely
 *
 * Safe by design:
 *   - never runs two batches at once (re-entrancy guard)
 *   - swallows all errors so a bad batch can't crash the server
 *   - interval is unref'd so it never keeps the process alive on its own
 *
 * Returns a stop() function that clears the interval.
 */
export function startValidationScheduler(
  db: Database.Database,
  opts?: { intervalMs?: number; batchSize?: number; actor?: string }
): () => void {
  if (process.env.KODA_VALIDATION_DISABLED === '1') {
    console.log('[validation-scheduler] disabled via KODA_VALIDATION_DISABLED=1');
    return () => {};
  }

  const intervalMs = opts?.intervalMs ?? Number(process.env.KODA_VALIDATION_INTERVAL_MS ?? 60_000);
  const batchSize = opts?.batchSize ?? Number(process.env.KODA_VALIDATION_BATCH_SIZE ?? 5);
  const actor = opts?.actor ?? 'sifututor';

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap batches
    running = true;
    try {
      const res = await runValidationBatch(db, actor, batchSize);
      if (res.processed > 0) {
        console.log(
          `[validation-scheduler] processed ${res.processed} ` +
            `(duplicates ${res.duplicates}, contradictions ${res.contradictions}, errors ${res.errors})`
        );
      }
    } catch (err) {
      console.warn('[validation-scheduler] batch error:', (err as Error).message);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  console.log(`[validation-scheduler] started — every ${intervalMs}ms, batch ${batchSize}`);
  return () => clearInterval(handle);
}
