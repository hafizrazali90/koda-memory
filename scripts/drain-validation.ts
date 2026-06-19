/**
 * One-off bounded drain of the validation queue. Useful for clearing a large
 * backlog faster than the in-process scheduler (5/min), or for an operator to
 * process a controlled chunk on demand.
 *
 * Processes jobs in batches until the queue is empty or `maxJobs` is reached,
 * with a small delay between batches to stay gentle on the LLM API.
 *
 * The dequeue is atomic (jobs are flipped to 'processing'), so this is safe to
 * run WHILE the server's background scheduler is also running — they will not
 * double-process the same job.
 *
 * Usage:
 *   KODA_DB_PATH=/opt/koda/brain.db npx tsx scripts/drain-validation.ts [maxJobs] [batchSize]
 *   (defaults: maxJobs = unlimited, batchSize = 20)
 */
import { openDatabase } from '../src/db/connection.js';
import { runValidationBatch } from '../src/validation/engine.js';
import { getQueueDepth } from '../src/validation/queue.js';

const dbPath = process.env.KODA_DB_PATH;
if (!dbPath) {
  console.error('Set KODA_DB_PATH=/opt/koda/brain.db before running this script.');
  process.exit(1);
}

const maxJobs = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
const batchSize = process.argv[3] ? parseInt(process.argv[3], 10) : 20;
const DELAY_MS = 500;

const db = openDatabase({ dbPath });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let processed = 0;
let duplicates = 0;
let contradictions = 0;
let errors = 0;

console.log(`Starting drain — queue depth ${getQueueDepth(db)}, maxJobs ${maxJobs}, batch ${batchSize}`);

while (processed < maxJobs) {
  const res = await runValidationBatch(db, 'sifututor', batchSize);
  if (res.processed === 0) break; // queue empty

  processed += res.processed;
  duplicates += res.duplicates;
  contradictions += res.contradictions;
  errors += res.errors;

  process.stdout.write(
    `\r  processed ${processed} | dups ${duplicates} | contradictions ${contradictions} | errors ${errors} | remaining ${getQueueDepth(db)}   `
  );

  await sleep(DELAY_MS);
}

console.log(
  `\nDone. Processed ${processed} jobs — ${duplicates} duplicates, ${contradictions} contradictions, ${errors} errors.`
);
console.log(`Queue depth now ${getQueueDepth(db)}.`);

db.close();
