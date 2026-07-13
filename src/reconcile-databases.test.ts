import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from './db/connection.js';
import { reconcileDatabases } from './reconcile-databases.js';

const dirs: string[] = [];

function makePair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-reconcile-'));
  dirs.push(dir);
  const sourcePath = path.join(dir, 'source.db');
  const targetPath = path.join(dir, 'target.db');
  const source = openDatabase({ dbPath: sourcePath });
  const target = openDatabase({ dbPath: targetPath });
  return { sourcePath, targetPath, source, target };
}

function insertMemory(db: Database.Database, id: string, content: string, project = 'sifututor') {
  db.prepare(`
    INSERT INTO memories (id, project, category, content, source, confidence, created_at, user_id)
    VALUES (?, ?, 'fact', ?, 'auto-captured', 'confirmed', '2026-07-13T00:00:00Z', 'hafiz')
  `).run(id, project, content);
  db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, NULL, ?)')
    .run(id, content, '');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reconcileDatabases', () => {
  it('dry-runs without changing the target and reports conflicts without content', () => {
    const { sourcePath, targetPath, source, target } = makePair();
    insertMemory(source, 'shared', 'stale source value');
    insertMemory(target, 'shared', 'canonical target value');
    insertMemory(source, 'source-only', 'preserve me', 'Sifututor');
    source.close();
    target.close();

    const report = reconcileDatabases({ sourcePath, targetPath, apply: false });

    expect(report).toMatchObject({ sharedIds: 1, sharedConflicts: 1, sourceOnlyMemories: 1, insertedMemories: 0 });
    expect(JSON.stringify(report)).not.toContain('stale source value');
    const check = new Database(targetPath, { readonly: true });
    expect(check.prepare('SELECT COUNT(*) count FROM memories').get()).toEqual({ count: 1 });
    check.close();
  });

  it('imports only source-only memories and keeps the canonical shared row unchanged', () => {
    const { sourcePath, targetPath, source, target } = makePair();
    insertMemory(source, 'shared', 'stale source value');
    insertMemory(target, 'shared', 'canonical target value');
    insertMemory(source, 'source-only', 'preserve me', 'Sifututor');
    source.close();
    target.close();

    const report = reconcileDatabases({ sourcePath, targetPath, apply: true });

    expect(report.insertedMemories).toBe(1);
    const check = new Database(targetPath, { readonly: true });
    expect(check.prepare('SELECT content FROM memories WHERE id = ?').get('shared')).toEqual({ content: 'canonical target value' });
    expect(check.prepare('SELECT project FROM memories WHERE id = ?').get('source-only')).toEqual({ project: 'sifututor' });
    check.close();
  });

  it('copies tags, valid relationships, FTS rows, embeddings, and source-only sessions', () => {
    const { sourcePath, targetPath, source, target } = makePair();
    insertMemory(target, 'target-existing', 'target');
    insertMemory(source, 'source-one', 'first imported memory');
    insertMemory(source, 'source-two', 'second imported memory');
    source.prepare('INSERT INTO tags (memory_id, tag) VALUES (?, ?), (?, ?)')
      .run('source-one', 'alpha', 'source-one', 'beta');
    source.prepare(`INSERT INTO relationships (source_id, target_id, relation_type, created_at)
      VALUES ('source-one', 'source-two', 'relates-to', '2026-07-13T00:00:00Z')`).run();
    source.pragma('foreign_keys = OFF');
    source.prepare(`INSERT INTO relationships (source_id, target_id, relation_type, created_at)
      VALUES ('source-one', 'missing', 'relates-to', '2026-07-13T00:00:00Z')`).run();
    source.prepare(`INSERT INTO sessions (id, project, started_at, summary, user_id)
      VALUES ('session-source', 'Sifututor', '2026-07-13T00:00:00Z', 'summary', 'hafiz')`).run();
    const embedding = new Float32Array(1536);
    embedding[0] = 0.5;
    source.prepare('INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)')
      .run('source-one', Buffer.from(embedding.buffer));
    source.close();
    target.close();

    const report = reconcileDatabases({ sourcePath, targetPath, apply: true });

    expect(report).toMatchObject({ insertedMemories: 2, insertedTags: 2, insertedRelationships: 1, skippedRelationships: 1, insertedEmbeddings: 1, insertedSessions: 1 });
    const check = openDatabase({ dbPath: targetPath });
    expect(check.prepare('SELECT tag FROM tags WHERE memory_id = ? ORDER BY tag').all('source-one')).toEqual([{ tag: 'alpha' }, { tag: 'beta' }]);
    expect(check.prepare('SELECT COUNT(*) count FROM relationships').get()).toEqual({ count: 1 });
    expect(check.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH 'imported'").all()).toHaveLength(2);
    expect(check.prepare('SELECT COUNT(*) count FROM memory_embeddings WHERE memory_id = ?').get('source-one')).toEqual({ count: 1 });
    expect(check.prepare('SELECT project FROM sessions WHERE id = ?').get('session-source')).toEqual({ project: 'sifututor' });
    check.close();
  });

  it('is idempotent when apply is repeated', () => {
    const { sourcePath, targetPath, source, target } = makePair();
    insertMemory(source, 'source-only', 'preserve once');
    source.close();
    target.close();

    expect(reconcileDatabases({ sourcePath, targetPath, apply: true }).insertedMemories).toBe(1);
    expect(reconcileDatabases({ sourcePath, targetPath, apply: true })).toMatchObject({
      sourceOnlyMemories: 0,
      insertedMemories: 0,
      insertedTags: 0,
      insertedRelationships: 0,
      insertedEmbeddings: 0,
      insertedSessions: 0,
    });
  });
});
