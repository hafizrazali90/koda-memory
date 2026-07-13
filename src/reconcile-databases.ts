import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { normalizeProject } from './project-alias.js';

export interface ReconciliationOptions {
  sourcePath: string;
  targetPath: string;
  apply: boolean;
}

export interface ReconciliationReport {
  mode: 'dry-run' | 'apply';
  sourceMemories: number;
  targetMemoriesBefore: number;
  targetMemoriesAfter: number;
  sharedIds: number;
  sharedConflicts: number;
  sourceOnlyMemories: number;
  plannedTags: number;
  plannedRelationships: number;
  plannedEmbeddings: number;
  plannedSessions: number;
  insertedMemories: number;
  insertedTags: number;
  insertedRelationships: number;
  skippedRelationships: number;
  insertedEmbeddings: number;
  insertedSessions: number;
}

type Row = Record<string, unknown>;

const CONFLICT_FIELDS = [
  'project', 'category', 'content', 'why', 'source', 'confidence', 'user_id',
  'created_by', 'flagged_outdated_by', 'flagged_outdated_at', 'superseded_at',
  'deleted_at', 'embedding_model', 'conflicts_with', 'duplicate_of',
] as const;

function openExisting(path: string, readonly: boolean): Database.Database {
  const db = new Database(path, { readonly, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  sqliteVec.load(db);
  return db;
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
    .map((row) => row.name);
}

function insertRow(db: Database.Database, table: string, row: Row, allowedColumns: Set<string>): number {
  const columns = Object.keys(row).filter((column) => allowedColumns.has(column));
  const names = columns.map((column) => `"${column}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  return db.prepare(`INSERT OR IGNORE INTO "${table}" (${names}) VALUES (${placeholders})`)
    .run(...columns.map((column) => row[column])).changes;
}

function differs(source: Row, target: Row): boolean {
  return CONFLICT_FIELDS.some((field) => (source[field] ?? null) !== (target[field] ?? null));
}

export function reconcileDatabases(options: ReconciliationOptions): ReconciliationReport {
  if (options.sourcePath === options.targetPath) throw new Error('Source and target database paths must differ.');

  const source = openExisting(options.sourcePath, true);
  const target = openExisting(options.targetPath, !options.apply);

  try {
    const sourceRows = source.prepare('SELECT * FROM memories ORDER BY id').all() as Row[];
    const targetRows = target.prepare('SELECT * FROM memories ORDER BY id').all() as Row[];
    const targetById = new Map(targetRows.map((row) => [String(row.id), row]));
    const sourceOnly = sourceRows.filter((row) => !targetById.has(String(row.id)));
    const sourceOnlyIds = new Set(sourceOnly.map((row) => String(row.id)));
    const shared = sourceRows.filter((row) => targetById.has(String(row.id)));
    const sharedConflicts = shared.filter((row) => differs(row, targetById.get(String(row.id))!)).length;
    const sourceTags = source.prepare('SELECT memory_id, tag FROM tags ORDER BY memory_id, tag').all() as Row[];
    const plannedTags = sourceTags.filter((row) => sourceOnlyIds.has(String(row.memory_id))).length;
    const sourceRelationships = source.prepare('SELECT * FROM relationships ORDER BY source_id, target_id, relation_type').all() as Row[];
    const finalIds = new Set([...targetById.keys(), ...sourceOnlyIds]);
    const validRelationships = sourceRelationships.filter((row) => finalIds.has(String(row.source_id)) && finalIds.has(String(row.target_id)));
    const dependencyRelationships = validRelationships.filter((row) =>
      sourceOnlyIds.has(String(row.source_id)) || sourceOnlyIds.has(String(row.target_id))
    );
    const targetRelationshipKeys = new Set(
      (target.prepare('SELECT source_id, target_id, relation_type FROM relationships').all() as Row[])
        .map((row) => `${row.source_id}\u0000${row.target_id}\u0000${row.relation_type}`)
    );
    const missingRelationships = dependencyRelationships.filter((row) =>
      !targetRelationshipKeys.has(`${row.source_id}\u0000${row.target_id}\u0000${row.relation_type}`)
    );
    const skippedRelationships = sourceRelationships.length - validRelationships.length;
    const sourceEmbeddings = source.prepare('SELECT memory_id, embedding FROM memory_embeddings ORDER BY memory_id').all() as Row[];
    const plannedEmbeddings = sourceEmbeddings.filter((row) => sourceOnlyIds.has(String(row.memory_id))).length;
    const targetSessionIds = new Set((target.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((row) => row.id));
    const sourceSessions = (source.prepare('SELECT * FROM sessions ORDER BY id').all() as Row[])
      .filter((row) => !targetSessionIds.has(String(row.id)));

    const report: ReconciliationReport = {
      mode: options.apply ? 'apply' : 'dry-run',
      sourceMemories: sourceRows.length,
      targetMemoriesBefore: targetRows.length,
      targetMemoriesAfter: targetRows.length,
      sharedIds: shared.length,
      sharedConflicts,
      sourceOnlyMemories: sourceOnly.length,
      plannedTags,
      plannedRelationships: missingRelationships.length,
      plannedEmbeddings,
      plannedSessions: sourceSessions.length,
      insertedMemories: 0,
      insertedTags: 0,
      insertedRelationships: 0,
      skippedRelationships,
      insertedEmbeddings: 0,
      insertedSessions: 0,
    };

    if (!options.apply) return report;

    const memoryColumns = new Set(tableColumns(target, 'memories'));
    const relationshipColumns = new Set(tableColumns(target, 'relationships'));
    const sessionColumns = new Set(tableColumns(target, 'sessions'));

    target.transaction(() => {
      for (const row of sourceOnly) {
        const normalized = { ...row, project: normalizeProject(String(row.project)) };
        report.insertedMemories += insertRow(target, 'memories', normalized, memoryColumns);
      }

      for (const row of sourceTags) {
        if (sourceOnlyIds.has(String(row.memory_id))) {
          report.insertedTags += target.prepare('INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)')
            .run(row.memory_id, row.tag).changes;
        }
      }

      for (const row of missingRelationships) {
        report.insertedRelationships += insertRow(target, 'relationships', row, relationshipColumns);
      }

      for (const row of sourceEmbeddings) {
        if (sourceOnlyIds.has(String(row.memory_id))) {
          report.insertedEmbeddings += target.prepare('INSERT OR IGNORE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)')
            .run(row.memory_id, row.embedding).changes;
        }
      }

      for (const row of sourceSessions) {
        const normalized = { ...row, project: normalizeProject(String(row.project)) };
        report.insertedSessions += insertRow(target, 'sessions', normalized, sessionColumns);
      }

      for (const row of sourceOnly) {
        const tags = target.prepare('SELECT tag FROM tags WHERE memory_id = ? ORDER BY tag').all(row.id) as { tag: string }[];
        target.prepare('DELETE FROM memories_fts WHERE id = ?').run(row.id);
        target.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)')
          .run(row.id, row.content, row.why ?? null, tags.map((tag) => tag.tag).join(' '));
      }

      const targetCount = (target.prepare('SELECT COUNT(*) count FROM memories').get() as { count: number }).count;
      const expected = targetRows.length + sourceOnly.length;
      if (targetCount !== expected) throw new Error(`Target count mismatch: expected ${expected}, got ${targetCount}.`);

      const foreignKeyErrors = target.pragma('foreign_key_check') as unknown[];
      if (foreignKeyErrors.length > 0) throw new Error(`Foreign-key verification failed with ${foreignKeyErrors.length} violation(s).`);
      report.targetMemoriesAfter = targetCount;
    })();

    return report;
  } finally {
    source.close();
    target.close();
  }
}
