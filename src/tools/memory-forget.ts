import type Database from 'better-sqlite3';

export interface MemoryForgetResult {
  id: string;
  message: string;
}

export function memoryForget(db: Database.Database, id: string): MemoryForgetResult {
  // Verify memory exists
  const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
  if (!existing) {
    throw new Error(`Memory ${id} not found`);
  }

  db.transaction(() => {
    // Delete from all tables (cascade via foreign keys, but be explicit)
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
