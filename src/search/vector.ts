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
 */
export async function vectorSearch(
  db: Database.Database,
  query: string,
  limit: number = 20
): Promise<VectorResult[]> {
  if (!isEmbeddingAvailable()) {
    return [];
  }

  const queryEmbedding = await generateEmbedding(query);

  return vectorSearchByEmbedding(db, queryEmbedding, limit);
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
