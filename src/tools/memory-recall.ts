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
  created_by: string | null;
  human_reviewed_at: string | null;
  flagged_outdated_by: string | null;
  flagged_outdated_at: string | null;
  superseded_at: string | null;
}

export function memoryRecall(db: Database.Database, id: string): MemoryEntry | null {
  // Check existence first
  const exists = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
  if (!exists) {
    return null;
  }

  // Update access tracking first so we return the current count
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
  ).run(now, id);

  // Read the updated memory
  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;

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
    created_by: memory.created_by ?? null,
    human_reviewed_at: memory.human_reviewed_at ?? null,
    flagged_outdated_by: memory.flagged_outdated_by ?? null,
    flagged_outdated_at: memory.flagged_outdated_at ?? null,
    superseded_at: memory.superseded_at ?? null,
  };
}
