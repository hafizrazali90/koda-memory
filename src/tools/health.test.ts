/**
 * project_health / auto_archive user-scoping regression test.
 *
 * Until 2026-07-13, projectHealth() and archiveStaleMemories() took no userId
 * at all and operated over the entire brain.db — every caller saw global
 * counts (including other users' personal memories, and full content of
 * anyone's flagged memories), and auto_archive could silently downgrade the
 * confidence of another user's private memories. Every other tool
 * (memory_search, memory_update, memory_forget) already enforced the
 * own+shared+project visibility boundary; this locks the same boundary in
 * for health/archive.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase } from '../db/connection.js';
import { memoryStore } from './memory-store.js';
import { projectHealth, archiveStaleMemories } from './health.js';
import type Database from 'better-sqlite3';

describe('project_health / auto_archive user scoping', () => {
  const testDir = path.join(os.tmpdir(), `koda-health-scope-test-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('does not count another user\'s personal memories', async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });

    await memoryStore(db, 'proj', 'alice', { content: 'Alice private note', category: 'fact' }, 'alice');
    await memoryStore(db, 'proj', 'bob', { content: 'Bob private note', category: 'fact' }, 'bob');
    await memoryStore(db, 'proj', 'sifututor', { content: 'Shared team note', category: 'fact' }, 'alice');

    const aliceReport = projectHealth(db, 'alice');
    expect(aliceReport.memory.total_memories).toBe(2); // her own + shared, not bob's

    const bobReport = projectHealth(db, 'bob');
    expect(bobReport.memory.total_memories).toBe(2); // his own + shared, not alice's
  });

  it('does not leak another user\'s flagged memory content', async () => {
    const bobPrivate = await memoryStore(db, 'proj', 'bob', { content: 'Bob secret plan', category: 'fact' }, 'bob');
    db.prepare("UPDATE memories SET flagged_outdated_by = 'bob', flagged_outdated_at = datetime('now') WHERE id = ?")
      .run(bobPrivate.id);

    const aliceReport = projectHealth(db, 'alice');
    expect(aliceReport.memory.flagged_for_review.find((m) => m.id === bobPrivate.id)).toBeUndefined();

    const bobReport = projectHealth(db, 'bob');
    expect(bobReport.memory.flagged_for_review.find((m) => m.id === bobPrivate.id)).toBeDefined();
  });

  it('auto_archive does not touch another user\'s personal memories', async () => {
    const carolMem = await memoryStore(db, 'proj', 'carol', { content: 'Carol old note', category: 'fact' }, 'carol');
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?').run(ninetyDaysAgo, carolMem.id);

    // alice runs auto_archive — must not touch carol's private stale memory
    archiveStaleMemories(db, 'alice');

    const carolMemAfter = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(carolMem.id) as { confidence: string };
    expect(carolMemAfter.confidence).not.toBe('outdated');

    // carol runs it herself — now it should archive
    const result = archiveStaleMemories(db, 'carol');
    expect(result.archived).toBeGreaterThanOrEqual(1);
    const carolMemFinal = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(carolMem.id) as { confidence: string };
    expect(carolMemFinal.confidence).toBe('outdated');
  });
});
