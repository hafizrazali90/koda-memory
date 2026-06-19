/**
 * WAL-safe backup of the Koda brain database.
 *
 * Why this exists: copying brain.db with `cp` only grabs the main file and
 * misses anything still in the -wal (write-ahead log), producing a SILENTLY
 * INCOMPLETE backup (observed 2026-06-19: a cp backup was missing 8 memories).
 *
 * This uses better-sqlite3's online backup API, which copies a complete,
 * consistent snapshot of the live database — including WAL contents — while the
 * server keeps running. It then VERIFIES the copy by comparing memory counts
 * and refuses to keep a backup that doesn't match the source.
 *
 * Usage:
 *   KODA_DB_PATH=/opt/koda/brain.db npx tsx scripts/backup-db.ts
 *
 * Optional env:
 *   KODA_BACKUP_DIR   where to write backups (default: <db dir>/backups)
 *   KODA_BACKUP_KEEP  how many backups to retain (default: 14)
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dbPath = process.env.KODA_DB_PATH || process.argv[2];
if (!dbPath) {
  console.error('Set KODA_DB_PATH=/opt/koda/brain.db (or pass the path as arg 1).');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const backupDir = process.env.KODA_BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
const keep = Number(process.env.KODA_BACKUP_KEEP || 14);
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-06-19T10-30-00
const dest = path.join(backupDir, `brain-${stamp}.db`);

async function main() {
  // Open read-only — we never want a backup run to mutate the live DB.
  const src = new Database(dbPath, { readonly: true });
  const srcCount = (src.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;

  // Online backup: page-level copy of a consistent snapshot (WAL included).
  await src.backup(dest);
  src.close();

  // Verify the backup is complete before trusting it.
  const bak = new Database(dest, { readonly: true });
  const bakCount = (bak.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
  bak.close();

  if (bakCount !== srcCount) {
    console.error(`BACKUP FAILED verification: source has ${srcCount} memories, backup has ${bakCount}. Removing bad backup.`);
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    process.exit(1);
  }

  const sizeMb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`Backup OK: ${dest} (${bakCount} memories, ${sizeMb} MB) — verified against source.`);

  // Retention: keep the newest `keep` backups, delete older ones.
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => /^brain-.*\.db$/.test(f))
    .sort(); // ISO timestamps sort chronologically
  const stale = files.slice(0, Math.max(0, files.length - keep));
  for (const f of stale) {
    fs.unlinkSync(path.join(backupDir, f));
    console.log(`  pruned old backup: ${f}`);
  }
  console.log(`Retention: ${Math.min(files.length, keep)} backups kept (max ${keep}).`);
}

main().catch((err) => {
  console.error('Backup error:', err);
  process.exit(1);
});
