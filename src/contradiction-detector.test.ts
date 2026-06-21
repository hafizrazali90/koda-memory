/**
 * Contradiction detector precision tests.
 *
 * The detector over-produced false "contradicts" edges in production (2026-06-21)
 * because it fed any FTS keyword-overlap pair to the LLM. These tests verify the
 * same-topic vector gate: pairs that aren't semantically close never reach the
 * LLM and never create an edge.
 *
 * The LLM and embedding layers are mocked so the suite stays deterministic/offline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('./llm/classifier.js', () => ({
  askYesNo: vi.fn(),
  isClassifierAvailable: () => true,
  classifierProvider: () => 'openai',
}));
vi.mock('./embeddings/openai.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, isEmbeddingAvailable: () => true };
});
vi.mock('./search/vector.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, embeddingSimilarity: vi.fn() };
});

import { openDatabase } from './db/connection.js';
import { detectContradiction } from './validation/contradiction-detector.js';
import { askYesNo } from './llm/classifier.js';
import { embeddingSimilarity } from './search/vector.js';
import type Database from 'better-sqlite3';

const USER = 'alice';
let db: Database.Database;
let tmpDir: string;
const idA = 'mem_contra_a';
const idB = 'mem_contra_b';

// Seed a memory directly (no embedding API calls) but indexed in FTS so the
// detector's ftsSearch can surface it as a candidate.
function seed(id: string, content: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, project, user_id, category, content, source, created_at, created_by)
     VALUES (?, 'p', ?, 'fact', ?, 'user-stated', ?, ?)`
  ).run(id, USER, content, now, USER);
  db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)').run(id, content, null, '');
}

beforeEach(() => {
  vi.mocked(askYesNo).mockReset();
  vi.mocked(embeddingSimilarity).mockReset();

  tmpDir = path.join(os.tmpdir(), `koda-contra-${Date.now()}-${Math.floor(performance.now())}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  db = openDatabase({ dbPath: path.join(tmpDir, 'brain.db') });

  // Two memories that share keywords (so FTS surfaces each as the other's candidate)
  seed(idA, 'The staging database host is alpha.db.example.com for the rebuild');
  seed(idB, 'The staging database host is beta.db.example.com for the rebuild');
});

afterEach(() => {
  db.close();
});

describe('Contradiction detector — same-topic vector gate', () => {
  it('low embedding similarity gates out the pair (LLM never called, no edge)', async () => {
    vi.mocked(embeddingSimilarity).mockReturnValue(0.40); // below 0.78 threshold
    vi.mocked(askYesNo).mockResolvedValue(true);          // would say YES if asked

    const result = await detectContradiction(db, idB, USER);

    expect(result.contradicts).toBe(false);
    expect(askYesNo).not.toHaveBeenCalled(); // gated before the LLM
    const edges = db.prepare("SELECT COUNT(*) c FROM relationships WHERE relation_type='contradicts'").get() as { c: number };
    expect(edges.c).toBe(0);
  });

  it('high similarity + LLM YES creates a contradicts edge', async () => {
    vi.mocked(embeddingSimilarity).mockReturnValue(0.90); // above threshold
    vi.mocked(askYesNo).mockResolvedValue(true);

    const result = await detectContradiction(db, idB, USER);

    expect(result.contradicts).toBe(true);
    expect(askYesNo).toHaveBeenCalled();
    const edges = db.prepare("SELECT COUNT(*) c FROM relationships WHERE relation_type='contradicts'").get() as { c: number };
    expect(edges.c).toBeGreaterThanOrEqual(1);
  });

  it('high similarity + LLM NO creates no edge', async () => {
    vi.mocked(embeddingSimilarity).mockReturnValue(0.90);
    vi.mocked(askYesNo).mockResolvedValue(false);

    const result = await detectContradiction(db, idB, USER);

    expect(result.contradicts).toBe(false);
    expect(askYesNo).toHaveBeenCalled(); // it WAS asked (passed the gate)
    const edges = db.prepare("SELECT COUNT(*) c FROM relationships WHERE relation_type='contradicts'").get() as { c: number };
    expect(edges.c).toBe(0);
  });
});
