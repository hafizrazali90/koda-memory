import type Database from 'better-sqlite3';

export interface MemoryForgetResult {
  id: string;
  message: string;
}

export function memoryForget(db: Database.Database, userId: string, id: string): MemoryForgetResult {
  // Verify memory exists AND belongs to this user (shared memories cannot be deleted by staff)
  const existing = db.prepare(
    'SELECT id FROM memories WHERE id = ? AND user_id = ?'
  ).get(id, userId);
  if (!existing) {
    throw new Error(`Memory ${id} not found or not owned by user '${userId}'`);
  }

  db.transaction(() => {
    db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
    db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
    db.prepare('DELETE FROM tags WHERE memory_id = ?').run(id);
    db.prepare('DELETE FROM relationships WHERE source_id = ? OR target_id = ?').run(id, id);
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  })();

  return {
    id,
    message: `Removed memory ${id} and all associated data (tags, relationships, embeddings, search index)`,
  };
}
