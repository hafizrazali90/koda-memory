import { describe, it, expect } from 'vitest';
import { blendResults, type MemoryMeta } from './blend.js';
import type { FtsResult } from './fts.js';
import type { VectorResult } from './vector.js';

function fts(id: string, score: number): FtsResult {
  return { id, content: id, why: null, tags: '', score };
}
function vec(id: string, score: number): VectorResult {
  return { id, distance: 1 - score, score };
}

describe('blendResults', () => {
  it('marks a result found by both fts and vector with both sources', () => {
    const out = blendResults([fts('a', -1)], [vec('a', 0.9)], [], 10);
    expect(out).toHaveLength(1);
    expect(out[0].sources.fts).toBeDefined();
    expect(out[0].sources.vector).toBeDefined();
  });

  it('combines fts + vector rather than first-writer-wins (P1)', () => {
    // 'a' wins fts, 'b' wins vector; a appears in both → should rank above b
    const out = blendResults([fts('a', -2), fts('b', -1)], [vec('a', 0.95), vec('b', 0.2)], [], 10);
    expect(out[0].id).toBe('a');
  });

  it('breaks ties toward more recent memories (P2 recency decay)', () => {
    const now = new Date().toISOString();
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const meta = new Map<string, MemoryMeta>([
      ['fresh', { created_at: now }],
      ['stale', { created_at: twoYearsAgo }],
    ]);
    // Equal FTS scores → recency is the only differentiator
    const out = blendResults([fts('fresh', -1), fts('stale', -1)], [], [], 10, meta);
    expect(out[0].id).toBe('fresh');
  });

  it('boosts confirmed + frequently-accessed memories (P6 signal boost)', () => {
    const now = new Date().toISOString();
    const meta = new Map<string, MemoryMeta>([
      ['proven', { created_at: now, confidence: 'confirmed', access_count: 50 }],
      ['unproven', { created_at: now, confidence: 'inferred', access_count: 0 }],
    ]);
    const out = blendResults([fts('proven', -1), fts('unproven', -1)], [], [], 10, meta);
    expect(out[0].id).toBe('proven');
  });

  it('respects the limit', () => {
    const out = blendResults([fts('a', -3), fts('b', -2), fts('c', -1)], [], [], 2);
    expect(out).toHaveLength(2);
  });

  it('caps the blended score at 1.0', () => {
    const now = new Date().toISOString();
    const meta = new Map<string, MemoryMeta>([['a', { created_at: now, confidence: 'confirmed', access_count: 99 }]]);
    const out = blendResults([fts('a', -1)], [vec('a', 1)], [], 10, meta);
    expect(out[0].score).toBeLessThanOrEqual(1.0);
  });
});
