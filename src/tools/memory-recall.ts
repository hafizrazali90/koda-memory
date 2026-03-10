import type Database from 'better-sqlite3';

export interface MemoryEntry {
  id: string;
  project: string;
  category: string;
  content: string;
  why: string | null;
  source: string;
  confidence: string;
  tags: string[];
  created_at: string;
  updated_at: string | null;
  last_accessed: string | null;
  access_count: number;
}

export function memoryRecall(db: Database.Database, id: string): MemoryEntry | null {
  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;

  if (!memory) {
    return null;
  }

  // Update access tracking
  db.prepare(`
    UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?
  `).run(new Date().toISOString(), id);

  // Get tags
  const tags = db.prepare('SELECT tag FROM tags WHERE memory_id = ?').all(id) as { tag: string }[];

  return {
    id: memory.id,
    project: memory.project,
    category: memory.category,
    content: memory.content,
    why: memory.why,
    source: memory.source,
    confidence: memory.confidence,
    tags: tags.map((t) => t.tag),
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    last_accessed: memory.last_accessed,
    access_count: memory.access_count,
  };
}
