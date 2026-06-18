import type Database from 'better-sqlite3';
import { storeEmbedding } from '../search/vector.js';

export interface MemoryUpdateInput {
  id: string;
  content?: string;
  why?: string;
  tags?: string[];
  confidence?: 'confirmed' | 'inferred' | 'outdated';
  source?: 'user-stated' | 'auto-captured' | 'correction';
}

export interface MemoryUpdateResult {
  id: string;
  message: string;
  fields_updated: string[];
  re_embedded: boolean;
}

export async function memoryUpdate(
  db: Database.Database,
  userId: string,
  input: MemoryUpdateInput
): Promise<MemoryUpdateResult> {
  // Verify memory exists AND belongs to this user (shared memories are read-only)
  const existing = db.prepare(
    'SELECT * FROM memories WHERE id = ? AND user_id = ?'
  ).get(input.id, userId) as any;
  if (!existing) {
    throw new Error(`Memory ${input.id} not found or not owned by user '${userId}'`);
  }

  const fieldsUpdated: string[] = [];
  const now = new Date().toISOString();

  db.transaction(() => {
    if (input.content !== undefined) {
      db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?').run(input.content, now, input.id);
      fieldsUpdated.push('content');
    }
    if (input.why !== undefined) {
      db.prepare('UPDATE memories SET why = ?, updated_at = ? WHERE id = ?').run(input.why, now, input.id);
      fieldsUpdated.push('why');
    }
    if (input.confidence !== undefined) {
      // An explicit confidence verdict is a human review — stamp the review clock
      // so auto-archive measures staleness from this touch, not passive search hits
      db.prepare('UPDATE memories SET confidence = ?, human_reviewed_at = ?, updated_at = ? WHERE id = ?').run(input.confidence, now, now, input.id);
      fieldsUpdated.push('confidence');
    }
    if (input.source !== undefined) {
      db.prepare('UPDATE memories SET source = ?, updated_at = ? WHERE id = ?').run(input.source, now, input.id);
      fieldsUpdated.push('source');
    }

    if (input.content !== undefined || input.why !== undefined) {
      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(input.id);
      const tags = db.prepare('SELECT tag FROM tags WHERE memory_id = ?').all(input.id) as { tag: string }[];
      const tagsText = tags.map((t) => t.tag).join(' ');
      const content = input.content ?? existing.content;
      const why = input.why ?? existing.why;
      db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)').run(
        input.id, content, why, tagsText
      );
    }

    if (input.tags !== undefined) {
      db.prepare('DELETE FROM tags WHERE memory_id = ?').run(input.id);
      const insertTag = db.prepare('INSERT INTO tags (memory_id, tag) VALUES (?, ?)');
      for (const tag of input.tags) insertTag.run(input.id, tag);
      fieldsUpdated.push('tags');

      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(input.id);
      const content = input.content ?? existing.content;
      const why = input.why ?? existing.why;
      db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)').run(
        input.id, content, why, input.tags.join(' ')
      );
    }
  })();

  let reEmbedded = false;
  if (input.content !== undefined || input.why !== undefined) {
    const content = input.content ?? existing.content;
    const why = input.why ?? existing.why;
    reEmbedded = await storeEmbedding(db, input.id, content, why);
  }

  return {
    id: input.id,
    message: `Updated memory ${input.id}: ${fieldsUpdated.join(', ')}`,
    fields_updated: fieldsUpdated,
    re_embedded: reEmbedded,
  };
}
