import type Database from 'better-sqlite3';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'flag'
  | 'unflag'
  | 'relate'
  | 'supersede';

/**
 * Append a row to the audit_log. This is the single write path for the
 * append-only history of every mutation to a memory.
 *
 * IMPORTANT: this must NEVER throw — an audit failure must not break the
 * underlying write. All errors are swallowed and logged as a warning.
 *
 * @param db        SQLite connection
 * @param memoryId  the memory being mutated
 * @param action    what happened (create/update/delete/...)
 * @param actor     the user_id responsible (the real author, not a shared namespace)
 * @param payload   optional structured detail (serialised to JSON)
 */
export function recordAudit(
  db: Database.Database,
  memoryId: string,
  action: AuditAction,
  actor: string,
  payload?: unknown
): void {
  try {
    db.prepare(
      `INSERT INTO audit_log (memory_id, action, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      memoryId,
      action,
      actor,
      payload === undefined ? null : JSON.stringify(payload),
      new Date().toISOString()
    );
  } catch (err) {
    // Audit logging is best-effort — never let it break the actual write.
    console.warn('[audit] failed to record', action, 'for', memoryId, ':', (err as Error).message);
  }
}
