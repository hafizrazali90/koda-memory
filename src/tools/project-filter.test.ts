/**
 * End-to-end test of the `project` filter added to memory_search,
 * memory_context, and project_health (2026-07-13) — the actual fix for
 * per-project scoping, complementing the tag-based workaround most memories
 * already use. Runs with OPENAI_API_KEY deleted (global test-setup), so this
 * exercises the FTS path only; the vector path is covered separately in
 * search/vector-filter.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase } from '../db/connection.js';
import { memoryStore } from './memory-store.js';
import { memorySearch } from './memory-search.js';
import { projectHealth } from './health.js';
import type Database from 'better-sqlite3';

describe('project filter — memory_search and project_health', () => {
  const testDir = path.join(os.tmpdir(), `koda-project-filter-test-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });

    await memoryStore(db, 'ripple-suite', 'alice', { content: 'Ripple billing rule', category: 'rule' }, 'alice');
    await memoryStore(db, 'sifu-tutor', 'alice', { content: 'Sifu billing rule', category: 'rule' }, 'alice');
    await memoryStore(db, 'sifu-tutor', 'alice', { content: 'Sifu auth rule', category: 'rule' }, 'alice');
    // Stored under the canonical name directly (memoryStore itself doesn't
    // normalize — normalization happens at the MCP write boundary via
    // resolveProject in index.ts). The read-side alias test below searches
    // with the alias "kelas" and expects it to resolve to "kelasapp".
    await memoryStore(db, 'kelasapp', 'alice', { content: 'Kelasapp pricing rule', category: 'rule' }, 'alice');
  });

  afterAll(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('memory_search narrows to the given project', async () => {
    const results = await memorySearch(db, 'alice', { query: 'rule', project: 'sifu-tutor', limit: 10 });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.content.startsWith('Sifu'))).toBe(true);
  });

  it('memory_search normalizes a known project alias before filtering', async () => {
    // The memory is stored under "kelasapp"; searching with the alias
    // "kelas" must still find it via normalizeProject.
    const results = await memorySearch(db, 'alice', { query: 'rule', project: 'kelas', limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe('Kelasapp pricing rule');
  });

  it('project_health scopes total_memories to the given project', () => {
    const all = projectHealth(db, 'alice');
    expect(all.memory.total_memories).toBe(4);

    const scoped = projectHealth(db, 'alice', 'sifu-tutor');
    expect(scoped.memory.total_memories).toBe(2);

    const other = projectHealth(db, 'alice', 'ripple-suite');
    expect(other.memory.total_memories).toBe(1);
  });
});
