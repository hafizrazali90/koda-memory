/**
 * Enqueue duplicate + contradiction validation jobs for every existing memory
 * that has never been validated (validation_checked_at IS NULL).
 *
 * The background scheduler in the running server then drains these gradually,
 * deduplicating the brain and building 'contradicts' / 'supersedes' graph links
 * over time. This is what makes the knowledge graph fill in and the dedup work
 * cover the whole existing corpus, not just newly-stored memories.
 *
 * SAFE: only inserts rows into validation_queue. Touches nothing else.
 * Idempotent-ish: skips memories that already have a pending/processing job of
 * the same type, so re-running won't pile up duplicate jobs.
 *
 * Usage: npx tsx scripts/enqueue-validation-backlog.ts <path-to-brain.db>
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2] || process.env.KODA_DB_PATH;
if (!dbPath) {
  console.error('Usage: npx tsx scripts/enqueue-validation-backlog.ts <path-to-brain.db>');
  console.error('   or: KODA_DB_PATH=/opt/koda/brain.db npx tsx scripts/enqueue-validation-backlog.ts');
  process.exit(1);
}

const db = new Database(dbPath);

// Memories never validated and not deleted
const unchecked = db.prepare(`
  SELECT id FROM memories
  WHERE validation_checked_at IS NULL
    AND deleted_at IS NULL
`).all() as { id: string }[];

console.log(`Found ${unchecked.length} memories never validated`);

const JOB_TYPES = ['duplicate_check', 'contradiction_check'] as const;

const hasPending = db.prepare(`
  SELECT 1 FROM validation_queue
  WHERE memory_id = ? AND job_type = ? AND status IN ('pending', 'processing')
  LIMIT 1
`);

const insert = db.prepare(`
  INSERT INTO validation_queue (memory_id, job_type, status, attempts, created_at)
  VALUES (?, ?, 'pending', 0, ?)
`);

let enqueued = 0;
let skipped = 0;
const now = new Date().toISOString();

const tx = db.transaction(() => {
  for (const m of unchecked) {
    for (const jobType of JOB_TYPES) {
      if (hasPending.get(m.id, jobType)) {
        skipped++;
        continue;
      }
      insert.run(m.id, jobType, now);
      enqueued++;
    }
  }
});
tx();

console.log(`Enqueued ${enqueued} validation jobs (${skipped} already pending, skipped).`);

const depth = db.prepare(
  "SELECT COUNT(*) as cnt FROM validation_queue WHERE status = 'pending'"
).get() as { cnt: number };
console.log(`Queue now holds ${depth.cnt} pending jobs. The scheduler drains them automatically.`);

db.close();
