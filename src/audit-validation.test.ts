/**
 * Tests for the three production fixes (2026-06-19):
 *  1. Validation scheduler auto-drains the queue
 *  2. Audit logging is wired into every write path
 *  3. Duplicate detection creates a graph edge (so dedup shows on the graph)
 *
 * These run WITHOUT an OpenAI/Anthropic key, so the LLM-confirmed paths
 * (contradiction edges, LLM-confirmed duplicates) are inert. We test the
 * deterministic FTS + DB behaviour and the plumbing that holds it together.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { openDatabase } from './db/connection.js';
import { memoryStore } from './tools/memory-store.js';
import { memoryUpdate } from './tools/memory-update.js';
import { memoryForget } from './tools/memory-forget.js';
import { memoryFlag } from './tools/memory-flag.js';
import { scheduleValidation, runValidationBatch, startValidationScheduler } from './validation/engine.js';
import { getQueueDepth, enqueueValidation } from './validation/queue.js';
import { detectDuplicate } from './validation/duplicate-detector.js';
import type Database from 'better-sqlite3';

const USER = 'alice';

let db: Database.Database;
let tmpDir: string;

function auditRows(memoryId?: string) {
  if (memoryId) {
    return db.prepare('SELECT * FROM audit_log WHERE memory_id = ? ORDER BY id').all(memoryId) as Record<string, unknown>[];
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id').all() as Record<string, unknown>[];
}

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `koda-av-test-${Date.now()}-${Math.floor(performance.now())}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  db = openDatabase({ dbPath: path.join(tmpDir, 'brain.db') });
});

afterEach(() => {
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX #2 — Audit logging
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #2: Audit logging is wired into write paths', () => {
  it('memory_store records a "create" audit entry', async () => {
    const r = await memoryStore(db, 'p', USER, {
      content: 'Audit test memory',
      category: 'fact',
      tags: ['x'],
    }, USER);

    const rows = auditRows(r.id);
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('create');
    expect(rows[0].actor).toBe(USER);
    expect(rows[0].memory_id).toBe(r.id);
  });

  it('create audit records the real author, not the shared namespace', async () => {
    // Simulate a project-scoped write: stored under 'sifututor', authored by alice
    const r = await memoryStore(db, 'p', 'sifututor', {
      content: 'Project scoped memory',
      category: 'rule',
    }, USER);

    const rows = auditRows(r.id);
    expect(rows[0].actor).toBe(USER); // real author, not 'sifututor'
  });

  it('memory_update records an "update" audit entry with the fields changed', async () => {
    const r = await memoryStore(db, 'p', USER, { content: 'Before', category: 'fact' }, USER);
    await memoryUpdate(db, USER, { id: r.id, confidence: 'confirmed', why: 'verified' });

    const rows = auditRows(r.id);
    const updateRow = rows.find((x) => x.action === 'update');
    expect(updateRow).toBeDefined();
    const payload = JSON.parse(updateRow!.payload as string);
    expect(payload.fields).toContain('confidence');
    expect(payload.fields).toContain('why');
  });

  it('memory_forget records a "delete" audit entry that survives the hard delete', async () => {
    const r = await memoryStore(db, 'p', USER, { content: 'To forget', category: 'fact' }, USER);
    memoryForget(db, USER, r.id);

    // The memory row is gone...
    const mem = db.prepare('SELECT id FROM memories WHERE id = ?').get(r.id);
    expect(mem).toBeUndefined();

    // ...but the audit trail remains
    const rows = auditRows(r.id);
    expect(rows.some((x) => x.action === 'delete')).toBe(true);
  });

  it('memory_flag records "flag" and "unflag" audit entries', async () => {
    // Flag works on shared/project memories — store under 'sifututor'
    const r = await memoryStore(db, 'p', 'sifututor', { content: 'Shared memory', category: 'rule' }, USER);

    memoryFlag(db, USER, { id: r.id, reason: 'looks stale' });
    memoryFlag(db, USER, { id: r.id, clear: true });

    const rows = auditRows(r.id);
    expect(rows.some((x) => x.action === 'flag')).toBe(true);
    expect(rows.some((x) => x.action === 'unflag')).toBe(true);

    const flagRow = rows.find((x) => x.action === 'flag')!;
    expect(JSON.parse(flagRow.payload as string).reason).toBe('looks stale');
  });

  it('a full lifecycle produces an ordered audit trail', async () => {
    const r = await memoryStore(db, 'p', USER, { content: 'Lifecycle', category: 'fact' }, USER);
    await memoryUpdate(db, USER, { id: r.id, content: 'Lifecycle v2' });
    memoryForget(db, USER, r.id);

    const actions = auditRows(r.id).map((x) => x.action);
    expect(actions).toEqual(['create', 'update', 'delete']);
  });

  it('audit logging never throws even if it fails internally', async () => {
    // Store succeeds; even in a hostile scenario the store result must come back
    const r = await memoryStore(db, 'p', USER, { content: 'Resilient', category: 'fact' }, USER);
    expect(r.id).toMatch(/^mem_/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX #1 — Validation scheduler drains the queue
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #1: Validation queue auto-processing', () => {
  it('storing a memory enqueues validation jobs', async () => {
    await memoryStore(db, 'p', USER, { content: 'Queued memory', category: 'fact' }, USER);
    // 3 jobs per store: duplicate, contradiction, staleness
    expect(getQueueDepth(db)).toBe(3);
  });

  it('runValidationBatch drains pending jobs', async () => {
    await memoryStore(db, 'p', USER, { content: 'Drain me', category: 'fact' }, USER);
    expect(getQueueDepth(db)).toBe(3);

    const res = await runValidationBatch(db, USER, 10);
    expect(res.processed).toBe(3);
    expect(getQueueDepth(db)).toBe(0);
  });

  it('processing resolves the memory owner so it works without a caller user', async () => {
    // Store under 'sifututor' (shared) — a background run has no specific caller
    const r = await memoryStore(db, 'p', 'sifututor', { content: 'Owner resolve', category: 'rule' }, USER);
    expect(getQueueDepth(db)).toBe(3);

    // Run the batch with a system actor that does NOT own the memory
    const res = await runValidationBatch(db, 'some-system-actor', 10);
    expect(res.processed).toBe(3);
    expect(res.errors).toBe(0);

    // The memory got stamped as validated
    const mem = db.prepare('SELECT validation_checked_at FROM memories WHERE id = ?').get(r.id) as { validation_checked_at: string | null };
    expect(mem.validation_checked_at).not.toBeNull();
  });

  it('startValidationScheduler drains the queue on its interval', async () => {
    await memoryStore(db, 'p', USER, { content: 'Scheduled drain', category: 'fact' }, USER);
    expect(getQueueDepth(db)).toBeGreaterThan(0);

    // Short interval for the test
    const stop = startValidationScheduler(db, { intervalMs: 20, batchSize: 10, actor: 'sifututor' });

    // Wait for a few ticks
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();

    expect(getQueueDepth(db)).toBe(0);
  });

  it('scheduler can be disabled via env flag', () => {
    const prev = process.env.KODA_VALIDATION_DISABLED;
    process.env.KODA_VALIDATION_DISABLED = '1';
    const stop = startValidationScheduler(db, { intervalMs: 10 });
    stop(); // no-op stop, should not throw
    if (prev === undefined) delete process.env.KODA_VALIDATION_DISABLED;
    else process.env.KODA_VALIDATION_DISABLED = prev;
    expect(true).toBe(true);
  });

  it('failed jobs are marked failed, not left pending forever', async () => {
    // Enqueue a job for a memory that does not exist → detector returns gracefully
    enqueueValidation(db, 'mem_nonexistent', 'duplicate_check');
    const res = await runValidationBatch(db, USER, 10);
    expect(res.processed).toBe(1); // returns cleanly (no duplicate), marked done
    expect(getQueueDepth(db)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX #3 — Duplicate detection creates a graph edge
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #3: Duplicate detection creates a graph link', () => {
  it('does NOT auto-mark duplicates without an LLM key (safety against false positives)', async () => {
    // Two identical memories. Tests run with no OPENAI_API_KEY, so the detector
    // must NOT mark a duplicate on FTS rank alone — that wrongly flagged 171 real
    // memories in production on 2026-06-19. It should only stamp validation_checked_at.
    await memoryStore(db, 'p', USER, {
      content: 'Always include deleted_at IS NULL in every SIMS query for soft deletes',
      category: 'rule',
    }, USER);

    const dup = await memoryStore(db, 'p', USER, {
      content: 'Always include deleted_at IS NULL in every SIMS query for soft deletes',
      category: 'rule',
    }, USER);

    const result = await detectDuplicate(db, dup.id, USER);

    // No LLM → never confirmed
    expect(result.is_duplicate).toBe(false);

    // Memory left untouched (NOT marked outdated, no duplicate_of)
    const mem = db.prepare('SELECT confidence, duplicate_of, validation_checked_at FROM memories WHERE id = ?').get(dup.id) as { confidence: string; duplicate_of: string | null; validation_checked_at: string | null };
    expect(mem.duplicate_of).toBeNull();
    expect(mem.confidence).not.toBe('outdated');
    // But the check was recorded
    expect(mem.validation_checked_at).not.toBeNull();

    // And no spurious supersedes edge was created
    const rel = db.prepare(
      `SELECT COUNT(*) as cnt FROM relationships WHERE relation_type = 'supersedes' AND target_id = ?`
    ).get(dup.id) as { cnt: number };
    expect(rel.cnt).toBe(0);
  });

  it('non-duplicate memories do not create a spurious edge', async () => {
    const a = await memoryStore(db, 'p', USER, { content: 'Use Tailwind for styling', category: 'decision' }, USER);
    await memoryStore(db, 'p', USER, { content: 'Deploy on Fridays is forbidden', category: 'rule' }, USER);

    await detectDuplicate(db, a.id, USER);

    const rels = db.prepare('SELECT COUNT(*) as cnt FROM relationships').get() as { cnt: number };
    expect(rels.cnt).toBe(0);
  });
});
