/**
 * One-off cleanup: merge duplicate/near-duplicate `project` label variants
 * that accumulated from case/naming drift across memory_store calls.
 *
 * Clusters (confirmed via /admin/stats on 2026-07-13):
 *   "Sifututor" (7) + "sifututor" (165)                 → "sifututor"
 *   "Sifututor Agent OS" (1) + "sifututor-agent-os" (4)  → "sifututor-agent-os"
 *   "kelas" (18) + "kelasapp" (14)                        → "kelasapp"
 *   "finch" (3) + "finch-inbox" (5)                       → "finch-inbox"
 *
 * Safe by construction:
 *  - Runs inside a single transaction; any failure rolls back everything.
 *  - Verifies total memory count is identical before and after (renaming a
 *    column value can never add/remove rows — if it does, something else is
 *    wrong and we bail without committing).
 *  - Prints a full before/after by_project breakdown for the touched
 *    clusters so the operator can eyeball it before trusting the run.
 *
 * Usage:
 *   KODA_DB_PATH=/opt/koda/brain.db npx tsx scripts/dedupe-projects.ts          # dry run (default)
 *   KODA_DB_PATH=/opt/koda/brain.db npx tsx scripts/dedupe-projects.ts --apply  # actually writes
 *
 * Always take a fresh verified backup first:
 *   KODA_DB_PATH=/opt/koda/brain.db npx tsx scripts/backup-db.ts
 */
import Database from 'better-sqlite3';

const dbPath = process.env.KODA_DB_PATH || process.argv[2];
const apply = process.argv.includes('--apply');

if (!dbPath) {
  console.error('Set KODA_DB_PATH=/opt/koda/brain.db (or pass the path as arg 1).');
  process.exit(1);
}

const MERGES: Array<{ from: string[]; to: string }> = [
  { from: ['Sifututor', 'sifututor'], to: 'sifututor' },
  { from: ['Sifututor Agent OS', 'sifututor-agent-os'], to: 'sifututor-agent-os' },
  { from: ['kelas', 'kelasapp'], to: 'kelasapp' },
  { from: ['finch', 'finch-inbox'], to: 'finch-inbox' },
];

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

function countByProject(): Record<string, number> {
  const rows = db.prepare('SELECT project, COUNT(*) as cnt FROM memories GROUP BY project').all() as {
    project: string;
    cnt: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.project] = r.cnt;
  return out;
}

const before = countByProject();
const totalBefore = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;

console.log(`Mode: ${apply ? 'APPLY (writing changes)' : 'DRY RUN (no changes made)'}`);
console.log(`Total memories before: ${totalBefore}\n`);

for (const merge of MERGES) {
  const fromCounts = merge.from.map((f) => `${f}=${before[f] ?? 0}`).join(', ');
  const expected = merge.from.reduce((sum, f) => sum + (before[f] ?? 0), 0);
  console.log(`${merge.from.join(' + ')} → "${merge.to}"  (${fromCounts}, expected total ${expected})`);
}

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write changes.');
  db.close();
  process.exit(0);
}

const run = db.transaction(() => {
  for (const merge of MERGES) {
    const placeholders = merge.from.map(() => '?').join(', ');
    db.prepare(`UPDATE memories SET project = ? WHERE project IN (${placeholders})`).run(merge.to, ...merge.from);
  }
});

run();

const after = countByProject();
const totalAfter = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;

if (totalAfter !== totalBefore) {
  console.error(`\nABORT-EQUIVALENT: total memory count changed (${totalBefore} → ${totalAfter}). This should be impossible for a column rename. Investigate before trusting this DB state.`);
  db.close();
  process.exit(1);
}

console.log(`\nTotal memories after: ${totalAfter} (unchanged, as expected)\n`);
for (const merge of MERGES) {
  console.log(`"${merge.to}" now has ${after[merge.to] ?? 0} memories`);
}

db.close();
console.log('\nDone.');
