/**
 * Reconcile a divergent source Koda database into a canonical target database.
 *
 * Existing target memory IDs always win. Only source-only memories and their
 * valid dependencies are inserted. Dry-run is the default.
 *
 * Usage:
 *   npx tsx scripts/reconcile-databases.ts --source /path/devtools.db --target /path/kvm8.db
 *   npx tsx scripts/reconcile-databases.ts --source /path/devtools.db --target /path/kvm8.db --apply
 */
import { reconcileDatabases } from '../src/reconcile-databases.js';

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourcePath = valueAfter('--source') || process.env.KODA_SOURCE_DB_PATH;
const targetPath = valueAfter('--target') || process.env.KODA_TARGET_DB_PATH;
const apply = process.argv.includes('--apply');

if (!sourcePath || !targetPath) {
  console.error('Provide --source and --target database paths (or KODA_SOURCE_DB_PATH and KODA_TARGET_DB_PATH).');
  process.exit(1);
}

try {
  const report = reconcileDatabases({ sourcePath, targetPath, apply });
  console.log(JSON.stringify(report, null, 2));
  if (!apply) console.log('Dry run only. No target rows were changed. Take fresh verified backups before --apply.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
