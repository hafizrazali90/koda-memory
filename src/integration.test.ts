import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { openDatabase } from './db/connection.js';
import { memoryStore } from './tools/memory-store.js';
import { memoryRecall } from './tools/memory-recall.js';
import { memorySearch } from './tools/memory-search.js';
import { memoryContext } from './tools/memory-context.js';
import { memoryUpdate } from './tools/memory-update.js';
import { memoryForget } from './tools/memory-forget.js';
import { memoryRelate } from './tools/memory-relate.js';
import { memoryFlag } from './tools/memory-flag.js';
import { sessionStart, sessionEnd, sessionList } from './tools/session.js';
import { projectHealth, archiveStaleMemories } from './tools/health.js';
import type Database from 'better-sqlite3';

// Integration tests run WITHOUT an OpenAI key, so embedding/LLM paths are
// inert (vector search returns [], no LLM processing). All assertions below
// are therefore FTS + graph deterministic.

describe('Koda Memory - Full Integration Test', () => {
  const testDir = path.join(os.tmpdir(), `koda-integration-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  const USER = 'alice';
  const project = 'test-project';
  let db: Database.Database;

  // IDs captured at store time (UUID-based since P7 — never assume sequential)
  const id: Record<string, string> = {};

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── memory_store ──

  it('stores a memory and returns a UUID-format ID', async () => {
    const result = await memoryStore(db, project, USER, {
      content: 'Never write directly to the SIMS MySQL database',
      category: 'rule',
      why: 'SIMS is read-only for our system; writes go through Neon',
      tags: ['sims', 'database', 'critical'],
      source: 'user-stated',
    });
    id.sims = result.id;
    expect(result.id).toMatch(/^mem_[0-9a-f]{12}$/);
    expect(result.message).toContain('rule');
    expect(result.message).toContain('3 tags');
  });

  it('stores multiple memories', async () => {
    const memories = [
      { key: 'drizzle', content: 'Use Drizzle ORM for all database queries in Ripple', category: 'decision' as const, tags: ['drizzle', 'database', 'ripple'] },
      { key: 'payment', content: 'Payment slips must show tutor bank details before processing', category: 'rule' as const, tags: ['payment', 'tutor', 'billing'] },
      { key: 'tailwind', content: 'Tailwind CSS is used for all frontend styling', category: 'decision' as const, tags: ['frontend', 'css', 'tailwind'] },
      { key: 'qa', content: 'Always run npm run qa before pushing to staging', category: 'rule' as const, tags: ['testing', 'workflow'] },
      { key: 'invoice', content: 'The invoice status flow is: draft then sent then paid then archived', category: 'fact' as const, tags: ['invoice', 'billing', 'workflow'] },
      { key: 'batch', content: 'Learned that batch operations need explicit transaction wrapping', category: 'lesson' as const, tags: ['database', 'lesson'] },
      { key: 'naming', content: 'User prefers snake_case for database columns and camelCase for TypeScript', category: 'preference' as const, tags: ['naming', 'convention'] },
      { key: 'auth', content: 'Supabase Auth handles all user authentication', category: 'fact' as const, tags: ['auth', 'supabase'] },
      { key: 'admin', content: 'The admin portal runs on Next.js 14 with App Router', category: 'fact' as const, tags: ['tech-stack', 'nextjs', 'admin'] },
    ];

    for (const m of memories) {
      const r = await memoryStore(db, project, USER, { content: m.content, category: m.category, tags: m.tags });
      id[m.key] = r.id;
    }

    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(count.c).toBe(10);
  });

  // ── memory_recall ──

  it('recalls a memory by ID with access tracking', () => {
    const memory = memoryRecall(db, USER, id.sims);
    expect(memory).not.toBeNull();
    expect(memory!.content).toContain('SIMS MySQL');
    expect(memory!.tags).toContain('sims');
    expect(memory!.access_count).toBe(1);

    const memory2 = memoryRecall(db, USER, id.sims);
    expect(memory2!.access_count).toBe(2);
  });

  it('records created_by provenance', () => {
    const memory = memoryRecall(db, USER, id.sims);
    expect(memory!.created_by).toBe(USER);
  });

  it('returns null for non-existent memory', () => {
    expect(memoryRecall(db, USER, 'mem_doesnotexist')).toBeNull();
  });

  // ── memory_search (FTS5) ──

  it('finds memories by keyword search', async () => {
    const results = await memorySearch(db, USER, { query: 'database' });
    expect(results.length).toBeGreaterThanOrEqual(2);
    const contents = results.map((r) => r.content);
    expect(contents.some((c) => c.includes('SIMS'))).toBe(true);
    expect(contents.some((c) => c.includes('Drizzle'))).toBe(true);
  });

  it('filters by category', async () => {
    const results = await memorySearch(db, USER, { query: 'database', category: 'rule' });
    expect(results.every((r) => r.category === 'rule')).toBe(true);
  });

  it('filters by tags', async () => {
    const results = await memorySearch(db, USER, { query: 'billing', tags: ['invoice'] });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].tags).toContain('invoice');
  });

  it('handles prefix search', async () => {
    const results = await memorySearch(db, USER, { query: 'payment*' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.map((r) => r.content.toLowerCase()).some((c) => c.includes('payment'))).toBe(true);
  });

  it('returns empty for nonsense query', async () => {
    const results = await memorySearch(db, USER, { query: 'xyzzyflurble' });
    expect(results.length).toBe(0);
  });

  // ── memory_relate (Graph) ──

  it('creates relationships between memories', () => {
    const result = memoryRelate(db, USER, { source_id: id.sims, target_id: id.drizzle, relation_type: 'relates-to' });
    expect(result.bidirectional).toBe(true);
    expect(result.message).toContain('relates-to');
  });

  it('creates directional relationships', () => {
    const result = memoryRelate(db, USER, { source_id: id.drizzle, target_id: id.naming, relation_type: 'depends-on' });
    expect(result.bidirectional).toBe(false);
  });

  it('rejects relationships with non-existent memories', () => {
    expect(() =>
      memoryRelate(db, USER, { source_id: id.sims, target_id: 'mem_nope', relation_type: 'relates-to' })
    ).toThrow('not found');
  });

  // ── memory_context (Blended Search) ──

  it('returns blended results for a task description', async () => {
    const result = await memoryContext(db, USER, {
      task_description: 'Working on the payment dashboard and billing features',
    });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.total_found).toBeGreaterThan(0);
    expect(result.search_summary).toContain('keyword');
    const contents = result.memories.map((m) => m.content.toLowerCase());
    expect(contents.some((c) => c.includes('payment') || c.includes('invoice') || c.includes('billing'))).toBe(true);
    for (const m of result.memories) {
      expect(m.relevance_score).toBeGreaterThanOrEqual(0);
      expect(m.sources.length).toBeGreaterThan(0);
    }
  });

  it('respects limit parameter', async () => {
    const result = await memoryContext(db, USER, { task_description: 'database queries', limit: 3 });
    expect(result.memories.length).toBeLessThanOrEqual(3);
  });

  // ── memory_update ──

  it('updates memory content and re-indexes FTS', async () => {
    const result = await memoryUpdate(db, USER, {
      id: id.qa,
      content: 'Always run npm run qa AND lint before pushing to staging',
      confidence: 'confirmed',
    });
    expect(result.fields_updated).toContain('content');
    expect(result.fields_updated).toContain('confidence');
    const searchResults = await memorySearch(db, USER, { query: 'lint staging' });
    expect(searchResults.some((r) => r.id === id.qa)).toBe(true);
  });

  it('setting confidence stamps human_reviewed_at', () => {
    const memory = memoryRecall(db, USER, id.qa);
    expect(memory!.human_reviewed_at).not.toBeNull();
  });

  it('updates tags', async () => {
    const result = await memoryUpdate(db, USER, { id: id.qa, tags: ['testing', 'workflow', 'lint', 'qa'] });
    expect(result.fields_updated).toContain('tags');
    const recalled = memoryRecall(db, USER, id.qa);
    expect(recalled!.tags).toContain('lint');
    expect(recalled!.tags).toContain('qa');
  });

  it('rejects update for non-existent memory', async () => {
    await expect(memoryUpdate(db, USER, { id: 'mem_nope', content: 'new content' })).rejects.toThrow('not found');
  });

  it('rejects update by a non-owner', async () => {
    await expect(memoryUpdate(db, 'mallory', { id: id.sims, content: 'hijack' })).rejects.toThrow();
  });

  // ── memory_forget ──

  it('removes a memory and all associated data', () => {
    expect(memoryRecall(db, USER, id.admin)).not.toBeNull();
    const result = memoryForget(db, USER, id.admin);
    expect(result.message).toContain('Removed');
    expect(memoryRecall(db, USER, id.admin)).toBeNull();
    expect(db.prepare('SELECT * FROM tags WHERE memory_id = ?').all(id.admin).length).toBe(0);
    expect(db.prepare('SELECT * FROM memories_fts WHERE id = ?').all(id.admin).length).toBe(0);
  });

  it('rejects forget for non-existent memory', () => {
    expect(() => memoryForget(db, USER, 'mem_nope')).toThrow();
  });

  it('rejects forget by a non-owner', () => {
    expect(() => memoryForget(db, 'mallory', id.sims)).toThrow();
  });

  // ── Sessions ──

  it('starts a session and returns context', () => {
    const result = sessionStart(db, project, USER);
    expect(result.session_id).toMatch(/^ses_/);
    expect(result.top_memories.length).toBeGreaterThan(0);
  });

  it('ends a session with summary', () => {
    const start = sessionStart(db, project, USER);
    const result = sessionEnd(db, USER, start.session_id, 'Built payment dashboard', 'feat/payments', 3);
    expect(result.message).toContain('Built payment dashboard');
  });

  it('lists sessions', () => {
    const result = sessionList(db, project, undefined, USER);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    expect(result.sessions.map((s) => s.summary)).toContain('Built payment dashboard');
  });

  it('rejects ending non-existent session', () => {
    expect(() => sessionEnd(db, USER, 'ses_fake', 'test')).toThrow('not found');
  });

  // ── Health Check ──

  it('returns project health report', () => {
    const report = projectHealth(db, USER);
    expect(report.memory.total_memories).toBe(9); // 10 stored - 1 forgotten
    expect(report.memory.by_category).toBeDefined();
    expect(report.environment.db_path).toContain('brain.db');
    expect(report.environment.db_size_kb).toBeGreaterThan(0);
  });

  it('archives stale memories but exempts confirmed ones', () => {
    // Backdate an inferred memory → should archive
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?').run(ninetyDaysAgo, id.auth);
    // Backdate a CONFIRMED memory → should NOT archive (P5 exemption)
    db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?').run(ninetyDaysAgo, id.qa);

    const result = archiveStaleMemories(db, USER);
    expect(result.archived).toBeGreaterThanOrEqual(1);

    expect((db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id.auth) as any).confidence).toBe('outdated');
    // confirmed memory survived
    expect((db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id.qa) as any).confidence).toBe('confirmed');
  });

  // ── Cross-cutting: search after updates/deletes ──

  it('search still works after updates and deletes', async () => {
    const results = await memorySearch(db, USER, { query: 'database' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.id !== id.admin)).toBe(true);
  });

  it('context search still works after modifications', async () => {
    const result = await memoryContext(db, USER, { task_description: 'testing and deployment workflow' });
    expect(result.memories.length).toBeGreaterThan(0);
  });
});

// ── Project scope + cross-user isolation (this session's headline feature) ──

describe('Koda Memory - Scope & isolation', () => {
  const testDir = path.join(os.tmpdir(), `koda-scope-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  const project = 'scope-project';
  let db: Database.Database;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });
    // alice's personal memory
    id.alicePersonal = (await memoryStore(db, project, 'alice', { content: 'ZONE alice private alpha', category: 'fact', tags: ['zone'] })).id;
    // a shared memory (legacy shared namespace)
    id.shared = (await memoryStore(db, project, 'shared', { content: 'ZONE shared bravo', category: 'fact', tags: ['zone'] })).id;
    // a project memory (scope=project → stored under 'sifututor', created_by alice)
    id.project = (await memoryStore(db, project, 'sifututor', { content: 'ZONE project charlie', category: 'fact', tags: ['zone'] }, 'alice')).id;
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('bob sees shared + project memories but NOT alice personal', async () => {
    const results = await memorySearch(db, 'bob', { query: 'ZONE' });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(id.shared);
    expect(ids).toContain(id.project);
    expect(ids).not.toContain(id.alicePersonal);
  });

  it('alice sees her personal + shared + project', async () => {
    const results = await memorySearch(db, 'alice', { query: 'ZONE' });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(id.alicePersonal);
    expect(ids).toContain(id.shared);
    expect(ids).toContain(id.project);
  });

  it('project memory records the real author in created_by', () => {
    const mem = memoryRecall(db, 'alice', id.project);
    expect(mem!.created_by).toBe('alice');
  });

  it('no user owns the project namespace, so it cannot be deleted by an individual', () => {
    // bob cannot delete the project memory (user_id = sifututor, not bob)
    expect(() => memoryForget(db, 'bob', id.project)).toThrow();
    // even alice (the author) cannot — ownership is by user_id, which is 'sifututor'
    expect(() => memoryForget(db, 'alice', id.project)).toThrow();
  });
});

// ── memory_flag governance ──

describe('Koda Memory - flag as outdated', () => {
  const testDir = path.join(os.tmpdir(), `koda-flag-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;
  let projectId: string;

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });
    projectId = (await memoryStore(db, 'flag-project', 'sifututor', { content: 'FLAGZONE shared rule', category: 'rule' }, 'alice')).id;
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('any team member can flag a project memory they can see', () => {
    const result = memoryFlag(db, 'bob', { id: projectId, reason: 'looks stale' });
    expect(result.flagged).toBe(true);
    const report = projectHealth(db, 'bob');
    expect(report.memory.flagged_count).toBe(1);
    expect(report.memory.flagged_for_review[0].flagged_outdated_by).toBe('bob');
  });

  it('flagging does not change confidence or delete the memory', () => {
    const mem = memoryRecall(db, 'alice', projectId);
    expect(mem).not.toBeNull();
    expect(mem!.confidence).not.toBe('outdated');
    expect(mem!.flagged_outdated_by).toBe('bob');
  });

  it('flag can be cleared', () => {
    const result = memoryFlag(db, 'carol', { id: projectId, clear: true });
    expect(result.flagged).toBe(false);
    expect(projectHealth(db, 'carol').memory.flagged_count).toBe(0);
  });

  it('cannot flag a memory you cannot see', () => {
    // a private memory owned by someone else
    db.prepare("INSERT INTO memories (id, project, user_id, category, content, created_at) VALUES ('mem_private01', 'flag-project', 'dave', 'fact', 'secret', datetime('now'))").run();
    expect(() => memoryFlag(db, 'bob', { id: 'mem_private01' })).toThrow();
  });
});

// ── Bi-temporal supersession (P10) ──

describe('Koda Memory - supersession', () => {
  const testDir = path.join(os.tmpdir(), `koda-supersede-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;
  let oldId: string;
  let newId: string;

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });
    oldId = (await memoryStore(db, 'sup-project', 'alice', { content: 'SUPZONE staging host is old-host.example.com', category: 'fact' })).id;
    newId = (await memoryStore(db, 'sup-project', 'alice', { content: 'SUPZONE staging host is sifu-staging.tutorla.tech', category: 'fact' })).id;
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('relate supersedes end-dates the target', () => {
    const result = memoryRelate(db, 'alice', { source_id: newId, target_id: oldId, relation_type: 'supersedes' });
    expect(result.superseded).toBe(oldId);
    const mem = memoryRecall(db, 'alice', oldId);
    expect(mem!.superseded_at).not.toBeNull();
    expect(mem!.confidence).toBe('outdated');
  });

  it('superseded memory is excluded from search', async () => {
    const results = await memorySearch(db, 'alice', { query: 'SUPZONE staging host' });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  it('superseded memory is still retrievable by id', () => {
    expect(memoryRecall(db, 'alice', oldId)).not.toBeNull();
  });

  it('health reports superseded_count', () => {
    expect(projectHealth(db, 'alice').memory.superseded_count).toBe(1);
  });
});

// ── Migration idempotency ──

describe('Koda Memory - migration idempotency', () => {
  const testDir = path.join(os.tmpdir(), `koda-migrate-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('re-opening the same DB re-runs migrations without error and stays at version 13', () => {
    const db1 = openDatabase({ dbPath });
    const v1 = (db1.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v;
    db1.close();

    // Second open runs runMigrations again — must be idempotent (no duplicate-column error)
    const db2 = openDatabase({ dbPath });
    const v2 = (db2.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v;
    db2.close();

    expect(v1).toBe(13);
    expect(v2).toBe(13);
  });
});

// ── FTS technical-term queries (P8 — stop-words no longer strip dev terms) ──

describe('Koda Memory - FTS technical terms', () => {
  const testDir = path.join(os.tmpdir(), `koda-fts-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });
    await memoryStore(db, 'fts-project', 'alice', { content: 'Every SIMS column must be NOT NULL by default', category: 'rule' });
    await memoryStore(db, 'fts-project', 'alice', { content: 'Run migrations from the working directory root', category: 'rule' });
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('finds "not null" (the word "not" is no longer a stop word)', async () => {
    const results = await memorySearch(db, 'alice', { query: 'not null' });
    expect(results.some((r) => r.content.includes('NOT NULL'))).toBe(true);
  });

  it('finds "working directory" (the word "working" is no longer a stop word)', async () => {
    const results = await memorySearch(db, 'alice', { query: 'working directory' });
    expect(results.some((r) => r.content.includes('working directory'))).toBe(true);
  });
});
