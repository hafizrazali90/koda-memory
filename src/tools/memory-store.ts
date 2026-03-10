import type Database from 'better-sqlite3';
import { storeEmbedding, vectorSearchByEmbedding } from '../search/vector.js';
import { generateEmbedding, isEmbeddingAvailable } from '../embeddings/openai.js';

export interface MemoryStoreInput {
  content: string;
  category: 'decision' | 'lesson' | 'rule' | 'preference' | 'fact';
  why?: string;
  tags?: string[];
  source?: 'user-stated' | 'auto-captured' | 'correction';
}

export interface SimilarMemory {
  id: string;
  content: string;
  similarity: number;
}

export interface MemoryStoreResult {
  id: string;
  message: string;
  embedded: boolean;
  warning?: string;
  similar_existing?: SimilarMemory[];
}

function generateId(db: Database.Database): string {
  const row = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
  const num = row.count + 1;
  return `mem_${String(num).padStart(4, '0')}`;
}

const SIMILARITY_THRESHOLD = 0.92;

export async function memoryStore(db: Database.Database, project: string, input: MemoryStoreInput): Promise<MemoryStoreResult> {
  // Check for similar existing memories before storing
  let similar: SimilarMemory[] = [];
  let embedding: Float32Array | null = null;

  if (isEmbeddingAvailable()) {
    try {
      const text = input.why ? `${input.content}\n${input.why}` : input.content;
      embedding = await generateEmbedding(text);

      const vecResults = vectorSearchByEmbedding(db, embedding, 5);
      similar = vecResults
        .filter((r) => r.score >= SIMILARITY_THRESHOLD)
        .map((r) => {
          const mem = db.prepare('SELECT content FROM memories WHERE id = ?').get(r.id) as { content: string } | undefined;
          return {
            id: r.id,
            content: mem?.content ?? '',
            similarity: Math.round(r.score * 100) / 100,
          };
        });
    } catch {
      // Continue without conflict detection
    }
  }

  const id = generateId(db);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO memories (id, project, category, content, why, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, project, input.category, input.content, input.why ?? null, input.source ?? 'auto-captured', now);

    const tagsText = input.tags?.join(' ') ?? '';
    db.prepare(`
      INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)
    `).run(id, input.content, input.why ?? null, tagsText);

    if (input.tags) {
      const insertTag = db.prepare('INSERT INTO tags (memory_id, tag) VALUES (?, ?)');
      for (const tag of input.tags) {
        insertTag.run(id, tag);
      }
    }
  })();

  // Store embedding (reuse if we already generated it for conflict detection)
  let embedded = false;
  if (embedding) {
    try {
      const { insertEmbedding } = await import('../search/vector.js');
      insertEmbedding(db, id, embedding);
      embedded = true;
    } catch {
      embedded = false;
    }
  } else {
    embedded = await storeEmbedding(db, id, input.content, input.why);
  }

  const result: MemoryStoreResult = {
    id,
    message: `Stored memory ${id} (${input.category}) with ${input.tags?.length ?? 0} tags`,
    embedded,
  };

  if (similar.length > 0) {
    result.warning = `Similar memory already exists. Consider using memory_update instead.`;
    result.similar_existing = similar;
  }

  return result;
}
