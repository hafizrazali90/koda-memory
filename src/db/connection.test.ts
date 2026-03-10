import { describe, it, expect, afterAll } from 'vitest';
import { openDatabase } from './connection.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Database Connection', () => {
  const testDir = path.join(os.tmpdir(), `koda-test-${Date.now()}`);
  let db: ReturnType<typeof openDatabase>;

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates .koda/brain.db with all tables', () => {
    db = openDatabase({ projectPath: testDir });

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('memories');
    expect(tableNames).toContain('tags');
    expect(tableNames).toContain('relationships');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('schema_version');
  });

  it('creates FTS5 virtual table', () => {
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get() as { name: string } | undefined;

    expect(fts).toBeDefined();
    expect(fts!.name).toBe('memories_fts');
  });

  it('creates sqlite-vec virtual table', () => {
    const vec = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'")
      .get() as { name: string } | undefined;

    expect(vec).toBeDefined();
    expect(vec!.name).toBe('memory_embeddings');
  });

  it('uses WAL mode', () => {
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('has foreign keys enabled', () => {
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('schema version is 1', () => {
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
  });

  it('can insert and query a memory', () => {
    db.prepare(`
      INSERT INTO memories (id, project, category, content, created_at)
      VALUES ('mem_001', 'test', 'fact', 'Test memory content', datetime('now'))
    `).run();

    const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get('mem_001') as any;
    expect(mem.content).toBe('Test memory content');
    expect(mem.category).toBe('fact');
  });

  it('FTS5 search works when index is populated', () => {
    // FTS is standalone — tool code manages inserts (no auto-triggers)
    db.prepare(
      "INSERT INTO memories_fts (id, content, why, tags) VALUES ('mem_001', 'Test memory content', NULL, 'testing')"
    ).run();

    const results = db
      .prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH 'test memory'")
      .all() as { id: string }[];

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('mem_001');
  });

  it('sqlite-vec can insert and query embeddings', () => {
    // Insert a dummy 1536-dim embedding (all zeros except first element)
    const embedding = new Float32Array(1536);
    embedding[0] = 1.0;

    db.prepare('INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)').run(
      'mem_001',
      Buffer.from(embedding.buffer)
    );

    const results = db
      .prepare(
        `SELECT memory_id, distance
         FROM memory_embeddings
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT 5`
      )
      .all(Buffer.from(embedding.buffer)) as { memory_id: string; distance: number }[];

    expect(results.length).toBe(1);
    expect(results[0].memory_id).toBe('mem_001');
    expect(results[0].distance).toBeCloseTo(0, 5);
  });
});
