import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { storeEmbedding, vectorSearchByEmbedding } from '../search/vector.js';
import { generateEmbedding, isEmbeddingAvailable } from '../embeddings/openai.js';
import { processMemory, isProcessorAvailable } from '../llm/processor.js';
import { scheduleValidation } from '../validation/engine.js';
import { recordAudit } from './audit.js';

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
  processed: boolean;
  warning?: string;
  similar_existing?: SimilarMemory[];
}

// Random UUID-based IDs — no MAX-then-increment race under concurrent writes.
// 12 hex chars = 48 bits of entropy; collision is negligible at any realistic scale.
function generateId(): string {
  return `mem_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

const SIMILARITY_THRESHOLD = 0.92;

export async function memoryStore(
  db: Database.Database,
  project: string,
  userId: string,
  input: MemoryStoreInput,
  createdBy?: string
): Promise<MemoryStoreResult> {
  // Step 1 — vector similarity check (find potential duplicates)
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
      // Continue without similarity check
    }
  }

  // Step 2 — LLM processing: clean content, auto-tags, duplicate detection
  let finalInput = input;
  let processed = false;

  if (isProcessorAvailable()) {
    try {
      const llmResult = await processMemory(input.content, project, similar);
      processed = true;

      // LLM says this is a duplicate — return early, don't store
      if (llmResult.duplicate_of) {
        return {
          id: llmResult.duplicate_of,
          message: `Duplicate detected — use memory_update on ${llmResult.duplicate_of} instead`,
          embedded: false,
          processed: true,
          warning: `LLM identified this as a duplicate of ${llmResult.duplicate_of}`,
          similar_existing: similar,
        };
      }

      finalInput = {
        content: llmResult.content,
        category: llmResult.category,
        why: llmResult.why || input.why,
        tags: llmResult.tags.length > 0 ? llmResult.tags : input.tags,
        source: input.source,
      };

      // Re-embed the cleaned content
      if (isEmbeddingAvailable()) {
        try {
          const cleanText = llmResult.why
            ? `${llmResult.content}\n${llmResult.why}`
            : llmResult.content;
          embedding = await generateEmbedding(cleanText);
        } catch {
          // Keep original embedding
        }
      }
    } catch {
      // LLM unavailable — store raw input as-is
    }
  }

  // Step 3 — persist to SQLite
  const id = generateId();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO memories (id, project, user_id, category, content, why, source, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, project, userId,
      finalInput.category, finalInput.content,
      finalInput.why ?? null,
      finalInput.source ?? 'auto-captured',
      now,
      createdBy ?? userId
    );

    const tagsText = finalInput.tags?.join(' ') ?? '';
    db.prepare(`
      INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)
    `).run(id, finalInput.content, finalInput.why ?? null, tagsText);

    if (finalInput.tags) {
      const insertTag = db.prepare('INSERT INTO tags (memory_id, tag) VALUES (?, ?)');
      for (const tag of finalInput.tags) {
        insertTag.run(id, tag);
      }
    }
  })();

  // Step 4 — store embedding
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
    embedded = await storeEmbedding(db, id, finalInput.content, finalInput.why);
  }

  const result: MemoryStoreResult = {
    id,
    message: `Stored memory ${id} (${finalInput.category}) with ${finalInput.tags?.length ?? 0} tags`,
    embedded,
    processed,
  };

  if (!processed && similar.length > 0) {
    result.warning = `Similar memory exists — consider memory_update instead.`;
    result.similar_existing = similar;
  }

  // Step 5 — record the create in the audit log (real author, not shared namespace)
  recordAudit(db, id, 'create', createdBy ?? userId, {
    category: finalInput.category,
    project,
    tags: finalInput.tags ?? [],
  });

  // Step 6 — schedule async validation (fire-and-forget, must never block the response)
  try {
    scheduleValidation(db, id, userId);
  } catch {
    // Validation scheduling failure is non-fatal — the memory was stored successfully
  }

  return result;
}
