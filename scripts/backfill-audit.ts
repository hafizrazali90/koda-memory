/**
 * Backfill a 'create' audit_log entry for every existing memory that has no
 * audit history yet. Makes the dashboard Audit page immediately useful instead
 * of empty, without touching the memories themselves.
 *
 * SAFE: append-only inserts into audit_log. Never updates or deletes a memory.
 * Idempotent: skips any memory that already has at least one audit row.
 *
 * Usage: npx tsx scripts/backfill-audit.ts <path-to-brain.db>
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2] || process.env.KODA_DB_PATH;
if (!dbPath) {
  console.error('Usage: npx tsx scripts/backfill-audit.ts <path-to-brain.db>');
  console.error('   or: KODA_DB_PATH=/opt/koda/brain.db npx tsx scripts/backfill-audit.ts');
  process.exit(1);
}

const db = new Database(dbPath);

// Memories that have NO audit_log row at all
const missing = db.prepare(`
  SELECT m.id, m.created_at, m.created_by, m.user_id, m.category, m.project
  FROM memories m
  LEFT JOIN audit_log a ON a.memory_id = m.id
  WHERE a.memory_id IS NULL
`).all() as {
  id: string;
  created_at: string | null;
  created_by: string | null;
  user_id: string;
  category: string;
  project: string;
}[];

console.log(`Found ${missing.length} memories with no audit history`);

const insert = db.prepare(`
  INSERT INTO audit_log (memory_id, action, actor, payload, created_at)
  VALUES (?, 'create', ?, ?, ?)
`);

let count = 0;
const tx = db.transaction(() => {
  for (const m of missing) {
    const actor = m.created_by || m.user_id || 'unknown';
    const payload = JSON.stringify({ category: m.category, project: m.project, backfilled: true });
    insert.run(m.id, actor, payload, m.created_at || new Date().toISOString());
    count++;
  }
});
tx();

console.log(`Backfilled ${count} 'create' audit entries.`);

const total = db.prepare('SELECT COUNT(*) as cnt FROM audit_log').get() as { cnt: number };
console.log(`audit_log now holds ${total.cnt} entries total.`);

db.close();
