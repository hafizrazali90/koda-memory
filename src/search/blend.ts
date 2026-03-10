import type { FtsResult } from './fts.js';
import type { VectorResult } from './vector.js';
import type { GraphResult } from './graph.js';

export interface BlendedResult {
  id: string;
  score: number;
  sources: {
    fts?: number;
    vector?: number;
    graph?: number;
  };
}

// Blending weights: FTS5 40% + Vector 40% + Graph 20%
const WEIGHT_FTS = 0.4;
const WEIGHT_VECTOR = 0.4;
const WEIGHT_GRAPH = 0.2;

/**
 * Blend results from FTS5, vector, and graph search into a single ranked list.
 * Normalizes scores to 0-1 range, applies weights, deduplicates.
 */
export function blendResults(
  ftsResults: FtsResult[],
  vectorResults: VectorResult[],
  graphResults: GraphResult[],
  limit: number = 15
): BlendedResult[] {
  const scoreMap = new Map<string, BlendedResult>();

  // Normalize FTS scores (BM25: lower = better, typically negative)
  const ftsNormalized = normalizeFtsScores(ftsResults);
  for (const { id, score } of ftsNormalized) {
    const entry = getOrCreate(scoreMap, id);
    entry.sources.fts = score;
    entry.score += score * WEIGHT_FTS;
  }

  // Vector scores are already 0-1 (similarity)
  for (const vec of vectorResults) {
    const entry = getOrCreate(scoreMap, vec.id);
    entry.sources.vector = vec.score;
    entry.score += vec.score * WEIGHT_VECTOR;
  }

  // Graph scores are already 0-1
  for (const graph of graphResults) {
    const entry = getOrCreate(scoreMap, graph.id);
    entry.sources.graph = graph.score;
    entry.score += graph.score * WEIGHT_GRAPH;
  }

  // Sort by blended score (descending) and return top N
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Normalize BM25 scores to 0-1 range.
 * BM25 scores from FTS5 are negative (more negative = better match).
 */
function normalizeFtsScores(results: FtsResult[]): { id: string; score: number }[] {
  if (results.length === 0) return [];

  // BM25 scores are negative; find min/max for normalization
  const scores = results.map((r) => r.score);
  const minScore = Math.min(...scores); // Most relevant (most negative)
  const maxScore = Math.max(...scores); // Least relevant
  const range = maxScore - minScore;

  return results.map((r) => ({
    id: r.id,
    // Invert: most negative becomes 1.0, least negative becomes ~0
    score: range === 0 ? 1.0 : (maxScore - r.score) / range,
  }));
}

function getOrCreate(map: Map<string, BlendedResult>, id: string): BlendedResult {
  let entry = map.get(id);
  if (!entry) {
    entry = { id, score: 0, sources: {} };
    map.set(id, entry);
  }
  return entry;
}
