import type Database from 'better-sqlite3';
import { generateEmbedding, isEmbeddingAvailable, EMBEDDING_DIMENSIONS } from '../embeddings/openai.js';

export interface VectorResult {
  id: string;
  distance: number;
  score: number; // Normalized similarity (0-1, higher = more similar)
}

/**
 * Insert an embedding for a memory.
 */
export function insertEmbedding(db: Database.Database, memoryId: string, embedding: Float32Array): void {
  db.prepare('INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)').run(
    memoryId,
    Buffer.from(embedding.buffer)
  );
}

/**
 * Delete an embedding for a memory.
 */
export function deleteEmbedding(db: Database.Database, memoryId: string): void {
  db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
}

/**
 * Search for similar memories using vector cosine distance.
 * When userId is given, restricts to the caller's own + shared + project memories.
 * sqlite-vec KNN uses LIMIT as k, so we can't filter pre-LIMIT — instead we
 * over-fetch candidates and filter by visibility, then trim to the page size.
 */
export async function vectorSearch(
  db: Database.Database,
  query: string,
  limit: number = 20,
  userId?: string
): Promise<VectorResult[]> {
  if (!isEmbeddingAvailable()) {
    return [];
  }

  const queryEmbedding = await generateEmbedding(query);

  if (!userId) {
    return vectorSearchByEmbedding(db, queryEmbedding, limit);
  }

  // Over-fetch (4x) then filter to visible memories
  const candidates = vectorSearchByEmbedding(db, queryEmbedding, limit * 4);
  if (candidates.length === 0) return [];

  const ids = candidates.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const visibleRows = db
    .prepare(
      `SELECT id FROM memories WHERE id IN (${placeholders})
         AND (user_id = ? OR user_id = 'shared' OR user_id = 'sifututor')
         AND superseded_at IS NULL`
    )
    .all(...ids, userId) as { id: string }[];
  const visible = new Set(visibleRows.map((r) => r.id));

  return candidates.filter((c) => visible.has(c.id)).slice(0, limit);
}

/**
 * Fetch a memory's stored embedding, or null if it has none.
 */
export function getEmbedding(db: Database.Database, memoryId: string): Float32Array | null {
  const row = db
    .prepare('SELECT embedding FROM memory_embeddings WHERE memory_id = ?')
    .get(memoryId) as { embedding: Buffer } | undefined;
  if (!row) return null;
  const buf = row.embedding;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/**
 * Cosine similarity (0-1, higher = more similar) between two memories' stored
 * embeddings. Returns null if either embedding is missing or dimensions differ.
 */
export function embeddingSimilarity(db: Database.Database, idA: string, idB: string): number | null {
  const a = getEmbedding(db, idA);
  const b = getEmbedding(db, idB);
  if (!a || !b || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp to [0,1] — embeddings are normalised so cosine is ~[-1,1]; negatives → 0
  return Math.max(0, Math.min(1, cosine));
}

/**
 * Search using a pre-computed embedding.
 */
export function vectorSearchByEmbedding(
  db: Database.Database,
  embedding: Float32Array,
  limit: number = 20
): VectorResult[] {
  const results = db
    .prepare(
      `SELECT memory_id, distance
       FROM memory_embeddings
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(Buffer.from(embedding.buffer), limit) as { memory_id: string; distance: number }[];

  // Convert distance to similarity score (0-1, higher = better)
  // sqlite-vec uses L2 distance by default; cosine distance ranges 0-2
  return results.map((r) => ({
    id: r.memory_id,
    distance: r.distance,
    score: Math.max(0, 1 - r.distance / 2), // Normalize cosine distance to similarity
  }));
}

/**
 * Generate and store an embedding for a memory.
 * Returns true if successful, false if embedding couldn't be generated.
 */
export async function storeEmbedding(
  db: Database.Database,
  memoryId: string,
  content: string,
  why?: string | null
): Promise<boolean> {
  if (!isEmbeddingAvailable()) {
    return false;
  }

  try {
    const text = why ? `${content}\n${why}` : content;
    const embedding = await generateEmbedding(text);
    insertEmbedding(db, memoryId, embedding);
    return true;
  } catch {
    // Embedding failed but memory is still stored
    return false;
  }
}

export { EMBEDDING_DIMENSIONS };
