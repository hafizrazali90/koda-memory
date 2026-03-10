import type Database from 'better-sqlite3';
import { storeEmbedding } from '../search/vector.js';

export interface MemoryUpdateInput {
  id: string;
  content?: string;
  why?: string;
  tags?: string[];
  confidence?: 'confirmed' | 'inferred' | 'outdated';
}

export interface MemoryUpdateResult {
  id: string;
  message: string;
  fields_updated: string[];
  re_embedded: boolean;
}

export async function memoryUpdate(db: Database.Database, input: MemoryUpdateInput): Promise<MemoryUpdateResult> {
  // Verify memory exists
  const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(input.id) as any;
  if (!existing) {
    throw new Error(`Memory ${input.id} not found`);
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
      db.prepare('UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?').run(
        input.confidence,
        now,
        input.id
      );
      fieldsUpdated.push('confidence');
    }

    // Update FTS index if content or why changed
    if (input.content !== undefined || input.why !== undefined) {
      // Delete old FTS entry
      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(input.id);

      // Get current tags for FTS
      const tags = db.prepare('SELECT tag FROM tags WHERE memory_id = ?').all(input.id) as { tag: string }[];
      const tagsText = tags.map((t) => t.tag).join(' ');

      // Re-insert into FTS
      const content = input.content ?? existing.content;
      const why = input.why ?? existing.why;
      db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)').run(
        input.id,
        content,
        why,
        tagsText
      );
    }

    // Update tags if provided
    if (input.tags !== undefined) {
      db.prepare('DELETE FROM tags WHERE memory_id = ?').run(input.id);
      const insertTag = db.prepare('INSERT INTO tags (memory_id, tag) VALUES (?, ?)');
      for (const tag of input.tags) {
        insertTag.run(input.id, tag);
      }
      fieldsUpdated.push('tags');

      // Update FTS tags column
      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(input.id);
      const content = input.content ?? existing.content;
      const why = input.why ?? existing.why;
      db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)').run(
        input.id,
        content,
        why,
        input.tags.join(' ')
      );
    }
  })();

  // Re-generate embedding if content changed
  let reEmbedded = false;
  if (input.content !== undefined) {
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
