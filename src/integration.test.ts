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
import { sessionStart, sessionEnd, sessionList } from './tools/session.js';
import { projectHealth, archiveStaleMemories } from './tools/health.js';
import type Database from 'better-sqlite3';

describe('Koda Memory - Full Integration Test', () => {
  const testDir = path.join(os.tmpdir(), `koda-integration-${Date.now()}`);
  let db: Database.Database;
  const project = 'test-project';

  beforeAll(() => {
    // Create a fake project structure for scanning
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ projectPath: testDir });
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── memory_store ──

  it('stores a memory and returns an ID', async () => {
    const result = await memoryStore(db, project, {
      content: 'Never write directly to the SIMS MySQL database',
      category: 'rule',
      why: 'SIMS is read-only for our system; writes go through Neon',
      tags: ['sims', 'database', 'critical'],
      source: 'user-stated',
    });

    expect(result.id).toBe('mem_0001');
    expect(result.message).toContain('rule');
    expect(result.message).toContain('3 tags');
  });

  it('stores multiple memories', async () => {
    const memories = [
      {
        content: 'Use Drizzle ORM for all database queries in Ripple',
        category: 'decision' as const,
        why: 'Chose Drizzle over Prisma for better SQL control',
        tags: ['drizzle', 'database', 'ripple'],
      },
      {
        content: 'Payment slips must show tutor bank details before processing',
        category: 'rule' as const,
        tags: ['payment', 'tutor', 'billing'],
      },
      {
        content: 'Tailwind CSS is used for all frontend styling',
        category: 'decision' as const,
        tags: ['frontend', 'css', 'tailwind'],
      },
      {
        content: 'Always run npm run qa before pushing to staging',
        category: 'rule' as const,
        why: 'Catches regressions before they reach staging',
        tags: ['testing', 'workflow'],
      },
      {
        content: 'The invoice status flow is: draft → sent → paid → archived',
        category: 'fact' as const,
        tags: ['invoice', 'billing', 'workflow'],
      },
      {
        content: 'Learned that batch operations need explicit transaction wrapping',
        category: 'lesson' as const,
        why: 'Without transactions, partial failures leave data inconsistent',
        tags: ['database', 'lesson'],
      },
      {
        content: 'User prefers snake_case for database columns and camelCase for TypeScript',
        category: 'preference' as const,
        tags: ['naming', 'convention'],
      },
      {
        content: 'Supabase Auth handles all user authentication',
        category: 'fact' as const,
        tags: ['auth', 'supabase'],
      },
      {
        content: 'The admin portal runs on Next.js 14 with App Router',
        category: 'fact' as const,
        tags: ['tech-stack', 'nextjs', 'admin'],
      },
    ];

    for (const m of memories) {
      await memoryStore(db, project, m);
    }

    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(count.c).toBe(10); // 1 from first test + 9 here
  });

  // ── memory_recall ──

  it('recalls a memory by ID with access tracking', () => {
    const memory = memoryRecall(db, 'mem_0001');
    expect(memory).not.toBeNull();
    expect(memory!.content).toContain('SIMS MySQL');
    expect(memory!.tags).toContain('sims');
    expect(memory!.access_count).toBe(1);

    // Recall again — access count should increment
    const memory2 = memoryRecall(db, 'mem_0001');
    expect(memory2!.access_count).toBe(2);
  });

  it('returns null for non-existent memory', () => {
    const memory = memoryRecall(db, 'mem_9999');
    expect(memory).toBeNull();
  });

  // ── memory_search (FTS5) ──

  it('finds memories by keyword search', async () => {
    const results = await memorySearch(db, { query: 'database' });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Should find SIMS and Drizzle memories
    const contents = results.map((r) => r.content);
    expect(contents.some((c) => c.includes('SIMS'))).toBe(true);
    expect(contents.some((c) => c.includes('Drizzle'))).toBe(true);
  });

  it('filters by category', async () => {
    const results = await memorySearch(db, { query: 'database', category: 'rule' });
    expect(results.every((r) => r.category === 'rule')).toBe(true);
  });

  it('filters by tags', async () => {
    const results = await memorySearch(db, { query: 'billing', tags: ['invoice'] });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].tags).toContain('invoice');
  });

  it('handles prefix search', async () => {
    const results = await memorySearch(db, { query: 'payment*' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const contents = results.map((r) => r.content.toLowerCase());
    expect(contents.some((c) => c.includes('payment'))).toBe(true);
  });

  it('returns empty for nonsense query', async () => {
    const results = await memorySearch(db, { query: 'xyzzyflurble' });
    expect(results.length).toBe(0);
  });

  // ── memory_relate (Graph) ──

  it('creates relationships between memories', () => {
    const result = memoryRelate(db, {
      source_id: 'mem_0001',
      target_id: 'mem_0002',
      relation_type: 'relates-to',
    });
    expect(result.bidirectional).toBe(true);
    expect(result.message).toContain('relates-to');
  });

  it('creates directional relationships', () => {
    const result = memoryRelate(db, {
      source_id: 'mem_0002',
      target_id: 'mem_0007',
      relation_type: 'depends-on',
    });
    expect(result.bidirectional).toBe(false);
  });

  it('rejects relationships with non-existent memories', () => {
    expect(() =>
      memoryRelate(db, {
        source_id: 'mem_0001',
        target_id: 'mem_9999',
        relation_type: 'relates-to',
      })
    ).toThrow('not found');
  });

  // ── memory_context (Blended Search) ──

  it('returns blended results for a task description', async () => {
    const result = await memoryContext(db, {
      task_description: 'Working on the payment dashboard and billing features',
    });

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.total_found).toBeGreaterThan(0);
    expect(result.search_summary).toContain('keyword');

    // Should find payment and billing related memories
    const contents = result.memories.map((m) => m.content.toLowerCase());
    expect(contents.some((c) => c.includes('payment') || c.includes('invoice') || c.includes('billing'))).toBe(true);

    // Each result should have a relevance score
    for (const m of result.memories) {
      expect(m.relevance_score).toBeGreaterThanOrEqual(0);
      expect(m.sources.length).toBeGreaterThan(0);
    }
  });

  it('respects limit parameter', async () => {
    const result = await memoryContext(db, {
      task_description: 'database queries',
      limit: 3,
    });
    expect(result.memories.length).toBeLessThanOrEqual(3);
  });

  // ── memory_update ──

  it('updates memory content and re-indexes FTS', async () => {
    const result = await memoryUpdate(db, {
      id: 'mem_0005',
      content: 'Always run npm run qa AND lint before pushing to staging',
      confidence: 'confirmed',
    });

    expect(result.fields_updated).toContain('content');
    expect(result.fields_updated).toContain('confidence');

    // Verify FTS is updated
    const searchResults = await memorySearch(db, { query: 'lint staging' });
    expect(searchResults.some((r) => r.id === 'mem_0005')).toBe(true);
  });

  it('updates tags', async () => {
    const result = await memoryUpdate(db, {
      id: 'mem_0005',
      tags: ['testing', 'workflow', 'lint', 'qa'],
    });
    expect(result.fields_updated).toContain('tags');

    const recalled = memoryRecall(db, 'mem_0005');
    expect(recalled!.tags).toContain('lint');
    expect(recalled!.tags).toContain('qa');
  });

  it('rejects update for non-existent memory', async () => {
    await expect(
      memoryUpdate(db, { id: 'mem_9999', content: 'new content' })
    ).rejects.toThrow('not found');
  });

  // ── memory_forget ──

  it('removes a memory and all associated data', () => {
    // First verify it exists
    expect(memoryRecall(db, 'mem_0010')).not.toBeNull();

    const result = memoryForget(db, 'mem_0010');
    expect(result.message).toContain('Removed');

    // Verify it's gone
    expect(memoryRecall(db, 'mem_0010')).toBeNull();

    // Verify tags are cleaned up
    const tags = db.prepare('SELECT * FROM tags WHERE memory_id = ?').all('mem_0010');
    expect(tags.length).toBe(0);

    // Verify FTS is cleaned up
    const fts = db.prepare("SELECT * FROM memories_fts WHERE id = 'mem_0010'").all();
    expect(fts.length).toBe(0);
  });

  it('rejects forget for non-existent memory', () => {
    expect(() => memoryForget(db, 'mem_9999')).toThrow('not found');
  });

  // ── Sessions ──

  it('starts a session and returns context', () => {
    const result = sessionStart(db, project);
    expect(result.session_id).toMatch(/^ses_/);
    expect(result.recent_sessions).toBeDefined();
    expect(result.top_memories).toBeDefined();
    expect(result.outdated_memories).toBeDefined();

    // Top memories should include ones we accessed
    expect(result.top_memories.length).toBeGreaterThan(0);
  });

  it('ends a session with summary', () => {
    const start = sessionStart(db, project);
    const result = sessionEnd(db, start.session_id, 'Built payment dashboard', 'feat/payments', 3);
    expect(result.message).toContain('Built payment dashboard');
  });

  it('lists sessions', () => {
    const result = sessionList(db, project);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    // At least one session should have the summary we set
    const summaries = result.sessions.map((s) => s.summary);
    expect(summaries).toContain('Built payment dashboard');
  });

  it('rejects ending non-existent session', () => {
    expect(() => sessionEnd(db, 'ses_fake', 'test')).toThrow('not found');
  });

  // ── Health Check ──

  it('returns project health report', () => {
    const report = projectHealth(db, testDir);

    expect(report.project_path).toBe(testDir);
    expect(report.memory.total_memories).toBe(9); // 10 stored - 1 forgotten
    expect(report.memory.by_category).toBeDefined();
    expect(report.environment.db_path).toContain('brain.db');
    expect(report.environment.db_size_kb).toBeGreaterThan(0);
  });

  it('archives stale memories', () => {
    // Manually backdate a memory's last_accessed to 90 days ago
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?').run(ninetyDaysAgo, 'mem_0009');

    const result = archiveStaleMemories(db);
    expect(result.archived).toBeGreaterThanOrEqual(1);

    // Verify confidence changed to outdated
    const mem = db.prepare('SELECT confidence FROM memories WHERE id = ?').get('mem_0009') as { confidence: string };
    expect(mem.confidence).toBe('outdated');
  });

  // ── Cross-cutting: search after updates/deletes ──

  it('search still works after updates and deletes', async () => {
    const results = await memorySearch(db, { query: 'database' });
    // mem_0010 was deleted, but other database memories should still be found
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.id !== 'mem_0010')).toBe(true);
  });

  it('context search still works after modifications', async () => {
    const result = await memoryContext(db, {
      task_description: 'testing and deployment workflow',
    });
    // Should find the updated mem_0005 (lint + qa)
    expect(result.memories.length).toBeGreaterThan(0);
  });
});
