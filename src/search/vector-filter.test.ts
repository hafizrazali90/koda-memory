/**
 * Direct test of vectorSearch's tag/category/project filtering.
 *
 * The global test-setup deletes OPENAI_API_KEY so no test makes a real
 * embedding call — which is exactly why the original bug (vectorSearch
 * silently ignoring tags/category entirely) shipped undetected: every
 * "filters by tags" test only ever exercised the FTS half. This file mocks
 * the embeddings module so vectorSearch's actual SQL filtering logic runs.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase } from '../db/connection.js';
import { memoryStore } from '../tools/memory-store.js';
import type Database from 'better-sqlite3';

vi.mock('../embeddings/openai.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(1536).fill(0.01)),
  isEmbeddingAvailable: () => true,
  EMBEDDING_DIMENSIONS: 1536,
}));

// Imported after the mock so vectorSearch picks it up.
const { vectorSearch } = await import('./vector.js');

describe('vectorSearch tag/category/project filtering', () => {
  const testDir = path.join(os.tmpdir(), `koda-vector-filter-test-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;
  let idA: string, idB: string, idC: string;

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });

    const a = await memoryStore(db, 'ripple-suite', 'alice', {
      content: 'Ripple memory about billing', category: 'fact', tags: ['billing'],
    }, 'alice');
    const b = await memoryStore(db, 'sifu-tutor', 'alice', {
      content: 'Sifu memory about billing', category: 'decision', tags: ['billing'],
    }, 'alice');
    const c = await memoryStore(db, 'sifu-tutor', 'alice', {
      content: 'Sifu memory about auth', category: 'fact', tags: ['auth'],
    }, 'alice');
    idA = a.id; idB = b.id; idC = c.id;
    // memoryStore already auto-embeds each memory via the mocked
    // generateEmbedding above, which always returns the same fixed vector —
    // so every row is an equally strong vector candidate, isolating the
    // filter logic under test from real semantic relevance.
  });

  afterAll(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('with no filters, returns all visible candidates', async () => {
    const results = await vectorSearch(db, 'billing', 10, 'alice');
    const ids = results.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([idA, idB, idC]));
  });

  it('filters by project', async () => {
    const results = await vectorSearch(db, 'billing', 10, 'alice', undefined, undefined, 'sifu-tutor');
    const ids = results.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([idB, idC]));
    expect(ids).not.toContain(idA);
  });

  it('filters by category', async () => {
    const results = await vectorSearch(db, 'billing', 10, 'alice', undefined, 'decision');
    const ids = results.map((r) => r.id);
    expect(ids).toEqual([idB]);
  });

  it('filters by tags', async () => {
    const results = await vectorSearch(db, 'billing', 10, 'alice', ['auth']);
    const ids = results.map((r) => r.id);
    expect(ids).toEqual([idC]);
  });

  it('combines project + category filters', async () => {
    const results = await vectorSearch(db, 'billing', 10, 'alice', undefined, 'fact', 'sifu-tutor');
    const ids = results.map((r) => r.id);
    expect(ids).toEqual([idC]);
  });
});
