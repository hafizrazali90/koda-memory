/**
 * Tests for the read-path vector timeout + FTS fallback.
 *
 * The point: a slow OpenAI embedding call must NOT hang a search. The vector
 * result is raced against a budget; on timeout the search proceeds with
 * keyword + graph results only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { withTimeout, vectorTimeoutMs } from './util/timeout.js';

// Mock vectorSearch so we can make it slow/hang without touching the network.
vi.mock('./search/vector.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, vectorSearch: vi.fn() };
});

import { openDatabase } from './db/connection.js';
import { memorySearch } from './tools/memory-search.js';
import { vectorSearch } from './search/vector.js';
import type Database from 'better-sqlite3';

describe('withTimeout()', () => {
  it('returns the value when the promise settles in time', async () => {
    const r = await withTimeout(Promise.resolve('ok'), 1000, 'fallback');
    expect(r).toBe('ok');
  });

  it('returns the fallback when the promise is too slow', async () => {
    const slow = new Promise<string>((res) => setTimeout(() => res('late'), 200));
    const r = await withTimeout(slow, 20, 'fallback');
    expect(r).toBe('fallback');
  });

  it('returns the fallback when the promise rejects', async () => {
    const r = await withTimeout(Promise.reject(new Error('boom')), 1000, 'fallback');
    expect(r).toBe('fallback');
  });
});

describe('vectorTimeoutMs()', () => {
  afterEach(() => { delete process.env.KODA_VECTOR_TIMEOUT_MS; });

  it('defaults to 800ms', () => {
    expect(vectorTimeoutMs()).toBe(800);
  });
  it('honours KODA_VECTOR_TIMEOUT_MS', () => {
    process.env.KODA_VECTOR_TIMEOUT_MS = '250';
    expect(vectorTimeoutMs()).toBe(250);
  });
  it('ignores garbage values', () => {
    process.env.KODA_VECTOR_TIMEOUT_MS = 'nonsense';
    expect(vectorTimeoutMs()).toBe(800);
  });
});

describe('memory_search degrades to FTS when the embedding call hangs', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    process.env.KODA_VECTOR_TIMEOUT_MS = '100'; // tight budget for the test
    tmpDir = path.join(os.tmpdir(), `koda-timeout-${Date.now()}-${Math.floor(performance.now())}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    db = openDatabase({ dbPath: path.join(tmpDir, 'brain.db') });

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, project, user_id, category, content, source, created_at, created_by)
       VALUES ('mem_t1', 'p', 'alice', 'fact', 'Deploy to staging before production always', 'user-stated', ?, 'alice')`
    ).run(now);
    db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)')
      .run('mem_t1', 'Deploy to staging before production always', null, '');
  });

  afterEach(() => {
    db.close();
    delete process.env.KODA_VECTOR_TIMEOUT_MS;
    vi.mocked(vectorSearch).mockReset();
  });

  it('returns FTS results quickly even when vectorSearch never resolves', async () => {
    // Simulate an embedding call that hangs forever.
    vi.mocked(vectorSearch).mockReturnValue(new Promise(() => {}));

    const start = performance.now();
    const results = await memorySearch(db, 'alice', { query: 'deploy staging', limit: 10 });
    const elapsed = performance.now() - start;

    // It returned (didn't hang) and found the memory via FTS
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('mem_t1');
    // And it came back near the 100ms budget, not blocked on the hung call
    expect(elapsed).toBeLessThan(2000);
  });

  it('still returns FTS results when vectorSearch rejects', async () => {
    vi.mocked(vectorSearch).mockRejectedValue(new Error('OpenAI 500'));
    const results = await memorySearch(db, 'alice', { query: 'deploy staging', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('mem_t1');
  });
});
