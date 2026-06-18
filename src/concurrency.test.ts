import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { openDatabase } from './db/connection.js';
import { memoryStore } from './tools/memory-store.js';
import { memorySearch } from './tools/memory-search.js';
import { memoryForget } from './tools/memory-forget.js';
import type Database from 'better-sqlite3';

// Validates the P7 fix (UUID IDs replacing MAX(id)+1). The old scheme could
// hand two interleaved stores the same next-id; UUIDs make that impossible.

describe('Concurrent writes (P7)', () => {
  const testDir = path.join(os.tmpdir(), `koda-concurrency-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('100 concurrent stores produce 100 unique IDs and 0 lost writes', async () => {
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        memoryStore(db, 'race', 'alice', { content: `concurrent memory number ${i}`, category: 'fact' })
      )
    );

    const ids = results.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(N); // no ID collisions

    const count = db.prepare("SELECT COUNT(*) as c FROM memories WHERE project = 'race'").get() as { c: number };
    expect(count.c).toBe(N); // no lost writes

    // Every ID is well-formed
    expect(ids.every((id) => /^mem_[0-9a-f]{12}$/.test(id))).toBe(true);
  });

  it('interleaved store + search + forget stay consistent', async () => {
    const stores = Array.from({ length: 30 }, (_, i) =>
      memoryStore(db, 'mixed', 'alice', { content: `mixed op widget ${i}`, category: 'fact' })
    );
    const searches = Array.from({ length: 10 }, () => memorySearch(db, 'alice', { query: 'widget' }));
    // Run stores and searches concurrently — must not throw or corrupt
    const [storeResults] = await Promise.all([Promise.all(stores), Promise.all(searches)]);

    expect(new Set(storeResults.map((r) => r.id)).size).toBe(30);

    // Concurrent deletes of distinct rows
    await Promise.all(storeResults.slice(0, 10).map((r) => Promise.resolve(memoryForget(db, 'alice', r.id))));
    const remaining = db.prepare("SELECT COUNT(*) as c FROM memories WHERE project = 'mixed'").get() as { c: number };
    expect(remaining.c).toBe(20);
  });
});

describe('Injection & malformed input resilience', () => {
  const testDir = path.join(os.tmpdir(), `koda-injection-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('SQL-injection-style content is stored as literal text, not executed', async () => {
    const evil = "Robert'); DROP TABLE memories;--";
    const r = await memoryStore(db, 'inj', 'alice', { content: evil, category: 'fact', tags: ["'; DROP TABLE tags;--"] });
    // The memories table must still exist and the row stored verbatim
    const row = db.prepare('SELECT content FROM memories WHERE id = ?').get(r.id) as { content: string };
    expect(row.content).toBe(evil);
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get();
    expect(tableCheck).toBeDefined();
  });

  it('FTS special characters in a query do not crash search', async () => {
    await memoryStore(db, 'inj', 'alice', { content: 'normal searchable content here', category: 'fact' });
    // These would be invalid raw FTS5 syntax if not sanitized — each must resolve to an array, not reject
    for (const q of ['"', '(', ')', 'AND OR NOT', '*', 'content) OR (1=1', '^$#@!', '   ']) {
      const results = await memorySearch(db, 'alice', { query: q });
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it('a very long query string does not crash search', async () => {
    const long = 'alpha '.repeat(5000);
    const results = await memorySearch(db, 'alice', { query: long });
    expect(Array.isArray(results)).toBe(true);
  });

  it('unicode and emoji content round-trips correctly', async () => {
    const content = 'Café ☕ 日本語 emoji 🎉 — naïve façade';
    const r = await memoryStore(db, 'inj', 'alice', { content, category: 'fact' });
    const row = db.prepare('SELECT content FROM memories WHERE id = ?').get(r.id) as { content: string };
    expect(row.content).toBe(content);
  });
});
