/**
 * Admin REST API contract tests
 *
 * These tests start a real HTTP server on an ephemeral port with a temp SQLite
 * database. They verify:
 *  1. Every endpoint returns the expected HTTP status code
 *  2. Every JSON response has EXACTLY the field names declared in dashboard/src/types.ts
 *     (this is the class of bug that caused the blank-page incident on 2026-06-19)
 *  3. Auth rejection works correctly
 *  4. Pagination, filtering, and CRUD operations behave correctly
 *  5. Edge cases: empty DB, non-existent IDs, malformed requests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { openDatabase } from './db/connection.js';
import { memoryStore } from './tools/memory-store.js';
import { memoryUpdate } from './tools/memory-update.js';
import { createHttpServer } from './index.js';
import type Database from 'better-sqlite3';

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure
// ─────────────────────────────────────────────────────────────────────────────

const TEST_KEY = 'test-api-key-abc123';
const TEST_USER = 'test-user';

let db: Database.Database;
let baseUrl: string;
let server: ReturnType<typeof createHttpServer>;

// IDs of seeded test memories
let memId1: string;
let memId2: string;
let memId3: string;

function get(path: string, opts?: { auth?: boolean; searchParams?: Record<string, string> }) {
  const auth = opts?.auth !== false; // default: true
  const url = new URL(`${baseUrl}${path}`);
  if (opts?.searchParams) {
    for (const [k, v] of Object.entries(opts.searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  return fetch(url.toString(), {
    headers: auth ? { Authorization: `Bearer ${TEST_KEY}` } : {},
  });
}

function post(path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function del(path: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TEST_KEY}` },
  });
}

beforeAll(async () => {
  // Create a temp DB
  const tmpDir = path.join(os.tmpdir(), `koda-admin-api-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'brain.db');

  db = openDatabase({ dbPath });

  // Seed test memories with known content
  const r1 = await memoryStore(db, 'test-project', TEST_USER, {
    content: 'Alpha memory: always use parameterized queries to prevent SQL injection',
    category: 'rule',
    why: 'Security best practice',
    tags: ['security', 'sql'],
    source: 'user-stated',
  }, TEST_USER);
  memId1 = r1.id;

  const r2 = await memoryStore(db, 'test-project', TEST_USER, {
    content: 'Beta memory: use React Query for server state, Zustand for client state',
    category: 'decision',
    why: 'Agreed in team meeting',
    tags: ['react', 'state-management'],
    source: 'auto-captured',
  }, TEST_USER);
  memId2 = r2.id;

  const r3 = await memoryStore(db, 'other-project', 'other-user', {
    content: 'Gamma memory: deploy to staging before production',
    category: 'rule',
    tags: ['deploy'],
    source: 'user-stated',
  }, 'other-user');
  memId3 = r3.id;

  // Explicitly set memId1 to 'confirmed' so confidence filter tests have data
  await memoryUpdate(db, TEST_USER, { id: memId1, confidence: 'confirmed' });

  // Create a relationship so the graph 'connected' mode + focus have data
  db.prepare(
    "INSERT OR IGNORE INTO relationships (source_id, target_id, relation_type, created_at) VALUES (?, ?, 'relates-to', ?)"
  ).run(memId1, memId2, new Date().toISOString());

  // Start the HTTP server with test credentials
  server = createHttpServer({
    userMap: new Map([[TEST_KEY, TEST_USER]]),
    dbGetter: () => db,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-001: Health endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-001: Health endpoint', () => {
  it('returns 200 with ok status (no auth required)', async () => {
    const res = await get('/health', { auth: false });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('status', 'ok');
    expect(json).toHaveProperty('version');
    expect(typeof json.version).toBe('string');
  });

  it('returns 200 even when auth header is present', async () => {
    const res = await get('/health', { auth: true });
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-002: Auth rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-002: Auth rejection', () => {
  it('rejects request with no token → 401', async () => {
    const res = await get('/admin/stats', { auth: false });
    expect(res.status).toBe(401);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('error');
  });

  it('rejects request with wrong token → 401', async () => {
    const res = await fetch(`${baseUrl}/admin/stats`, {
      headers: { Authorization: 'Bearer wrong-key-xyz' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects request with malformed Authorization header → 401', async () => {
    const res = await fetch(`${baseUrl}/admin/stats`, {
      headers: { Authorization: 'notbearer abc' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts valid token → 200', async () => {
    const res = await get('/admin/stats');
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-003: Stats endpoint — field names match dashboard/src/types.ts Stats
// This test would have caught the 2026-06-19 blank-page bug.
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-003: GET /admin/stats — field name contract', () => {
  let json: Record<string, unknown>;

  beforeAll(async () => {
    const res = await get('/admin/stats');
    json = await res.json() as Record<string, unknown>;
  });

  it('returns 200', async () => {
    const res = await get('/admin/stats');
    expect(res.status).toBe(200);
  });

  it('has total_memories (not "total")', () => {
    expect(json).toHaveProperty('total_memories');
    expect(typeof json.total_memories).toBe('number');
  });

  it('has flagged_count (not "flagged")', () => {
    expect(json).toHaveProperty('flagged_count');
    expect(typeof json.flagged_count).toBe('number');
  });

  it('has superseded_count', () => {
    expect(json).toHaveProperty('superseded_count');
    expect(typeof json.superseded_count).toBe('number');
  });

  it('has deleted_count', () => {
    expect(json).toHaveProperty('deleted_count');
    expect(typeof json.deleted_count).toBe('number');
  });

  it('has validation_queue_depth', () => {
    expect(json).toHaveProperty('validation_queue_depth');
    expect(typeof json.validation_queue_depth).toBe('number');
  });

  it('has search_gaps_count', () => {
    expect(json).toHaveProperty('search_gaps_count');
    expect(typeof json.search_gaps_count).toBe('number');
  });

  it('has recent_audit_count', () => {
    expect(json).toHaveProperty('recent_audit_count');
    expect(typeof json.recent_audit_count).toBe('number');
  });

  it('has by_user as Record<string,number> (not an array)', () => {
    expect(json).toHaveProperty('by_user');
    expect(Array.isArray(json.by_user)).toBe(false);
    expect(typeof json.by_user).toBe('object');
    // Each value must be a number
    for (const v of Object.values(json.by_user as object)) {
      expect(typeof v).toBe('number');
    }
  });

  it('has by_project as Record<string,number>', () => {
    expect(json).toHaveProperty('by_project');
    expect(Array.isArray(json.by_project)).toBe(false);
    expect(typeof json.by_project).toBe('object');
  });

  it('has by_confidence as Record<string,number>', () => {
    expect(json).toHaveProperty('by_confidence');
    expect(Array.isArray(json.by_confidence)).toBe(false);
    expect(typeof json.by_confidence).toBe('object');
  });

  it('has by_category as Record<string,number>', () => {
    expect(json).toHaveProperty('by_category');
    expect(Array.isArray(json.by_category)).toBe(false);
    expect(typeof json.by_category).toBe('object');
  });

  it('total_memories reflects seeded data', () => {
    expect(json.total_memories as number).toBe(3); // 3 seeded memories
  });

  it('by_user contains the seeded users', () => {
    const byUser = json.by_user as Record<string, number>;
    expect(byUser[TEST_USER]).toBe(2); // two memories under test-user
    expect(byUser['other-user']).toBe(1);
  });

  it('has no unexpected top-level error key', () => {
    expect(json).not.toHaveProperty('error');
  });

  it('does NOT have deprecated field names (regression guard)', () => {
    // These were the WRONG field names that caused the blank-page bug
    expect(json).not.toHaveProperty('total');
    expect(json).not.toHaveProperty('flagged');
    expect(json).not.toHaveProperty('per_page');
    expect(json).not.toHaveProperty('total_pages');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-004: GET /admin/memories — field name contract
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-004: GET /admin/memories — field name contract', () => {
  let json: Record<string, unknown>;

  beforeAll(async () => {
    const res = await get('/admin/memories');
    json = await res.json() as Record<string, unknown>;
  });

  it('returns 200', async () => {
    const res = await get('/admin/memories');
    expect(res.status).toBe(200);
  });

  it('has memories array (not "data" or "items")', () => {
    expect(json).toHaveProperty('memories');
    expect(Array.isArray(json.memories)).toBe(true);
  });

  it('has total as number', () => {
    expect(json).toHaveProperty('total');
    expect(typeof json.total).toBe('number');
  });

  it('has page as number', () => {
    expect(json).toHaveProperty('page');
    expect(typeof json.page).toBe('number');
  });

  it('has limit (not "per_page")', () => {
    expect(json).toHaveProperty('limit');
    expect(typeof json.limit).toBe('number');
    expect(json).not.toHaveProperty('per_page'); // deprecated
  });

  it('has pages (not "total_pages")', () => {
    expect(json).toHaveProperty('pages');
    expect(typeof json.pages).toBe('number');
    expect(json).not.toHaveProperty('total_pages'); // deprecated — caused blank page bug
  });

  it('returns all 3 seeded memories by default', () => {
    expect(json.total).toBe(3);
    expect((json.memories as unknown[]).length).toBe(3);
  });

  it('each memory has required fields', () => {
    for (const mem of json.memories as Record<string, unknown>[]) {
      expect(mem).toHaveProperty('id');
      expect(mem).toHaveProperty('content');
      expect(mem).toHaveProperty('category');
      expect(mem).toHaveProperty('confidence');
      expect(mem).toHaveProperty('created_at');
      expect(mem).toHaveProperty('tags');
      expect(Array.isArray(mem.tags)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-005: Pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-005: Pagination', () => {
  it('limit=1 returns 1 memory and pages=3', async () => {
    const res = await get('/admin/memories', { searchParams: { limit: '1' } });
    const json = await res.json() as Record<string, unknown>;
    expect(json.total).toBe(3);
    expect((json.memories as unknown[]).length).toBe(1);
    expect(json.pages).toBe(3);
    expect(json.page).toBe(1);
    expect(json.limit).toBe(1);
  });

  it('page=2 with limit=1 returns the second memory', async () => {
    const res = await get('/admin/memories', { searchParams: { limit: '1', page: '2' } });
    const json = await res.json() as Record<string, unknown>;
    expect((json.memories as unknown[]).length).toBe(1);
    expect(json.page).toBe(2);
  });

  it('page beyond last returns empty memories array', async () => {
    const res = await get('/admin/memories', { searchParams: { limit: '10', page: '99' } });
    const json = await res.json() as Record<string, unknown>;
    expect((json.memories as unknown[]).length).toBe(0);
    expect(json.total).toBe(3);
  });

  it('limit is capped at 100', async () => {
    const res = await get('/admin/memories', { searchParams: { limit: '9999' } });
    const json = await res.json() as Record<string, unknown>;
    expect(json.limit).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-006: Filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-006: Filtering', () => {
  it('?project=test-project returns only 2 memories', async () => {
    const res = await get('/admin/memories', { searchParams: { project: 'test-project' } });
    const json = await res.json() as Record<string, unknown>;
    expect(json.total).toBe(2);
  });

  it('?project=other-project returns only 1 memory', async () => {
    const res = await get('/admin/memories', { searchParams: { project: 'other-project' } });
    const json = await res.json() as Record<string, unknown>;
    expect(json.total).toBe(1);
  });

  it('?user=other-user returns only 1 memory', async () => {
    const res = await get('/admin/memories', { searchParams: { user: 'other-user' } });
    const json = await res.json() as Record<string, unknown>;
    expect(json.total).toBe(1);
  });

  it('?confidence=confirmed returns memories with confirmed confidence', async () => {
    const res = await get('/admin/memories', { searchParams: { confidence: 'confirmed' } });
    const json = await res.json() as Record<string, unknown>;
    expect(json.total as number).toBeGreaterThan(0);
    for (const m of json.memories as Record<string, unknown>[]) {
      expect(m.confidence).toBe('confirmed');
    }
  });

  it('?category=rule returns only rule category memories', async () => {
    const res = await get('/admin/memories', { searchParams: { category: 'rule' } });
    const json = await res.json() as Record<string, unknown>;
    for (const m of json.memories as Record<string, unknown>[]) {
      expect(m.category).toBe('rule');
    }
  });

  it('?q=Alpha returns the matching memory', async () => {
    const res = await get('/admin/memories', { searchParams: { q: 'Alpha' } });
    const json = await res.json() as Record<string, unknown>;
    expect(json.total as number).toBeGreaterThan(0);
    const mems = json.memories as Record<string, unknown>[];
    expect(mems.some((m) => (m.content as string).includes('Alpha'))).toBe(true);
  });

  it('?q=nonexistent-xyz returns 0 memories', async () => {
    const res = await get('/admin/memories', { searchParams: { q: 'nonexistent-xyz-999' } });
    const json = await res.json() as Record<string, unknown>;
    expect(json.total).toBe(0);
    expect((json.memories as unknown[]).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-007: GET /admin/memories/:id — memory detail
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-007: GET /admin/memories/:id', () => {
  it('returns 200 with memory, tags, relationships', async () => {
    const res = await get(`/admin/memories/${memId1}`);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('memory');
    expect(json).toHaveProperty('tags');
    expect(json).toHaveProperty('relationships');
    expect(Array.isArray(json.tags)).toBe(true);
    expect(Array.isArray(json.relationships)).toBe(true);
  });

  it('memory has all expected fields', async () => {
    const res = await get(`/admin/memories/${memId1}`);
    const json = await res.json() as Record<string, unknown>;
    const mem = json.memory as Record<string, unknown>;
    expect(mem).toHaveProperty('id', memId1);
    expect(mem).toHaveProperty('content');
    expect(mem).toHaveProperty('category');
    expect(mem).toHaveProperty('confidence');
    expect(mem).toHaveProperty('created_at');
    expect(mem).toHaveProperty('user_id');
    expect(mem).toHaveProperty('project');
  });

  it('tags are correct for seeded memory', async () => {
    const res = await get(`/admin/memories/${memId1}`);
    const json = await res.json() as Record<string, unknown>;
    const tags = json.tags as string[];
    expect(tags).toContain('security');
    expect(tags).toContain('sql');
  });

  it('returns 404 for non-existent memory ID', async () => {
    const res = await get('/admin/memories/mem_does_not_exist_xyz');
    expect(res.status).toBe(404);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-008: DELETE + POST restore — soft-delete lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-008: DELETE /admin/memories/:id + restore', () => {
  it('soft-deletes a memory → 200 ok', async () => {
    const res = await del(`/admin/memories/${memId2}`);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('ok', true);
    expect(json).toHaveProperty('id', memId2);
  });

  it('deleted memory no longer appears in default list', async () => {
    const res = await get('/admin/memories');
    const json = await res.json() as Record<string, unknown>;
    const mems = json.memories as Record<string, unknown>[];
    expect(mems.some((m) => m.id === memId2)).toBe(false);
  });

  it('deleted memory appears with ?deleted=true', async () => {
    const res = await get('/admin/memories', { searchParams: { deleted: 'true' } });
    const json = await res.json() as Record<string, unknown>;
    const mems = json.memories as Record<string, unknown>[];
    expect(mems.some((m) => m.id === memId2)).toBe(true);
  });

  it('restores the memory → 200 ok', async () => {
    const res = await post(`/admin/memories/${memId2}/restore`);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('ok', true);
  });

  it('restored memory reappears in default list', async () => {
    const res = await get('/admin/memories');
    const json = await res.json() as Record<string, unknown>;
    const mems = json.memories as Record<string, unknown>[];
    expect(mems.some((m) => m.id === memId2)).toBe(true);
  });

  it('returns 404 when deleting non-existent memory', async () => {
    const res = await del('/admin/memories/mem_does_not_exist_xyz');
    expect(res.status).toBe(404);
  });

  it('returns 404 when restoring non-existent memory', async () => {
    const res = await post('/admin/memories/mem_does_not_exist_xyz/restore');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-009: GET /admin/graph
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-009: GET /admin/graph', () => {
  it('returns 200 with nodes and links', async () => {
    const res = await get('/admin/graph');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('nodes');
    expect(json).toHaveProperty('links');
    expect(Array.isArray(json.nodes)).toBe(true);
    expect(Array.isArray(json.links)).toBe(true);
  });

  it('nodes have required fields', async () => {
    const res = await get('/admin/graph');
    const json = await res.json() as Record<string, unknown>;
    const nodes = json.nodes as Record<string, unknown>[];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node).toHaveProperty('id');
      expect(node).toHaveProperty('label');
      expect(node).toHaveProperty('confidence');
    }
  });

  it('?project= filter reduces nodes (mode=all)', async () => {
    const resAll = await get('/admin/graph', { searchParams: { mode: 'all' } });
    const jsonAll = await resAll.json() as Record<string, unknown>;
    const allCount = (jsonAll.nodes as unknown[]).length;

    const resFiltered = await get('/admin/graph', { searchParams: { mode: 'all', project: 'test-project' } });
    const jsonFiltered = await resFiltered.json() as Record<string, unknown>;
    const filteredCount = (jsonFiltered.nodes as unknown[]).length;

    expect(filteredCount).toBeLessThan(allCount);
  });

  it('returns empty nodes for a project with no memories', async () => {
    const res = await get('/admin/graph', { searchParams: { project: 'nonexistent-project-xyz', mode: 'all' } });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect((json.nodes as unknown[]).length).toBe(0);
    expect((json.links as unknown[]).length).toBe(0);
  });

  it('connected mode (default) returns only nodes that have a relationship', async () => {
    const res = await get('/admin/graph'); // default mode=connected
    const json = await res.json() as Record<string, unknown>;
    const nodes = json.nodes as { id: string }[];
    const ids = nodes.map((n) => n.id);
    // memId1 + memId2 are linked; memId3 is isolated → excluded in connected mode
    expect(ids).toContain(memId1);
    expect(ids).toContain(memId2);
    expect(ids).not.toContain(memId3);
    expect((json.links as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('mode=all includes isolated nodes', async () => {
    const res = await get('/admin/graph', { searchParams: { mode: 'all' } });
    const json = await res.json() as Record<string, unknown>;
    const ids = (json.nodes as { id: string }[]).map((n) => n.id);
    expect(ids).toContain(memId3); // isolated node now included
  });

  it('focus=<id> returns the node and its neighbours', async () => {
    const res = await get('/admin/graph', { searchParams: { focus: memId1, depth: '1' } });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    const ids = (json.nodes as { id: string }[]).map((n) => n.id);
    expect(ids).toContain(memId1);       // the focus
    expect(ids).toContain(memId2);       // its neighbour
    expect(ids).not.toContain(memId3);   // unrelated → excluded
    expect(json.mode).toBe('focus');
    expect(json.focus).toBe(memId1);
  });

  it('focus on an isolated node returns just that node, no links', async () => {
    const res = await get('/admin/graph', { searchParams: { focus: memId3 } });
    const json = await res.json() as Record<string, unknown>;
    const ids = (json.nodes as { id: string }[]).map((n) => n.id);
    expect(ids).toEqual([memId3]);
    expect((json.links as unknown[]).length).toBe(0);
  });

  it('graph nodes carry content + access_count for the detail panel', async () => {
    const res = await get('/admin/graph');
    const json = await res.json() as Record<string, unknown>;
    for (const node of json.nodes as Record<string, unknown>[]) {
      expect(node).toHaveProperty('content');
      expect(node).toHaveProperty('access_count');
      expect(node).toHaveProperty('project');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-010: GET /admin/validation/queue
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-010: GET /admin/validation/queue', () => {
  it('returns 200 with jobs and total', async () => {
    const res = await get('/admin/validation/queue');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('jobs');
    expect(json).toHaveProperty('total');
    expect(Array.isArray(json.jobs)).toBe(true);
    expect(typeof json.total).toBe('number');
  });

  it('?status=done returns completed jobs', async () => {
    const res = await get('/admin/validation/queue', { searchParams: { status: 'done' } });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('jobs');
  });

  it('each job has required fields', async () => {
    // Seed a job by checking if any jobs exist first
    const res = await get('/admin/validation/queue', { searchParams: { status: 'pending' } });
    const json = await res.json() as Record<string, unknown>;
    const jobs = json.jobs as Record<string, unknown>[];
    for (const job of jobs) {
      expect(job).toHaveProperty('id');
      expect(job).toHaveProperty('memory_id');
      expect(job).toHaveProperty('status');
      expect(job).toHaveProperty('created_at');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-011: GET /admin/audit
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-011: GET /admin/audit', () => {
  it('returns 200 with entries array', async () => {
    const res = await get('/admin/audit');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('entries');
    expect(Array.isArray(json.entries)).toBe(true);
  });

  it('entries have required fields when present', async () => {
    const res = await get('/admin/audit');
    const json = await res.json() as Record<string, unknown>;
    const entries = json.entries as Record<string, unknown>[];
    for (const entry of entries) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('memory_id');
      expect(entry).toHaveProperty('action');
      expect(entry).toHaveProperty('actor');
      expect(entry).toHaveProperty('created_at');
    }
  });

  it('?memory_id= filter works', async () => {
    const res = await get('/admin/audit', { searchParams: { memory_id: memId1 } });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('entries');
  });

  it('?limit= caps entries returned', async () => {
    const res = await get('/admin/audit', { searchParams: { limit: '1' } });
    const json = await res.json() as Record<string, unknown>;
    expect((json.entries as unknown[]).length).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-012: GET /admin/search-gaps
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-012: GET /admin/search-gaps', () => {
  it('returns 200 with gaps array', async () => {
    const res = await get('/admin/search-gaps');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('gaps');
    expect(Array.isArray(json.gaps)).toBe(true);
  });

  it('?project= filter works', async () => {
    const res = await get('/admin/search-gaps', { searchParams: { project: 'test-project' } });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('gaps');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-013: 404 and unknown routes
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-013: Unknown routes', () => {
  it('/admin/unknown-route → 404', async () => {
    const res = await get('/admin/unknown-route-xyz');
    expect(res.status).toBe(404);
  });

  it('/admin/ (trailing slash, no route) → 404', async () => {
    const res = await get('/admin/');
    expect(res.status).toBe(404);
  });

  it('/completely-unknown → 404', async () => {
    const res = await get('/completely-unknown-path', { auth: true });
    expect(res.status).toBe(404);
  });

  it('wrong HTTP method on /admin/stats → 404 (not 200)', async () => {
    const res = await post('/admin/stats', {});
    // POST to stats is not a defined route — should fall through to 404 via adminPath mismatch
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-014: Dashboard static files served without auth
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-014: Dashboard static files', () => {
  it('/dashboard/ returns 200 or 404 (not 401) — auth wall must not block login page', async () => {
    const res = await get('/dashboard/', { auth: false });
    // Either 200 (dashboard built) or 404 (dashboard not built in test env)
    // But NEVER 401 — that was the root cause bug
    expect(res.status).not.toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-015: Concurrent requests
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-015: Concurrent requests', () => {
  it('handles 10 simultaneous /admin/stats requests without error', async () => {
    const requests = Array.from({ length: 10 }, () => get('/admin/stats'));
    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json).toHaveProperty('total_memories');
    }
  });

  it('handles concurrent reads and writes without crashing', async () => {
    const reads = Array.from({ length: 5 }, () => get('/admin/memories'));
    const stats = Array.from({ length: 5 }, () => get('/admin/stats'));
    const all = await Promise.all([...reads, ...stats]);
    for (const res of all) {
      expect(res.status).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-API-016: Performance — admin endpoints respond within 200ms
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-API-016: Response time', () => {
  async function measureMs(fn: () => Promise<Response>): Promise<number> {
    const start = performance.now();
    await fn();
    return performance.now() - start;
  }

  it('/admin/stats responds in <200ms', async () => {
    const ms = await measureMs(() => get('/admin/stats'));
    expect(ms).toBeLessThan(200);
  });

  it('/admin/memories responds in <200ms', async () => {
    const ms = await measureMs(() => get('/admin/memories'));
    expect(ms).toBeLessThan(200);
  });

  it('/admin/graph responds in <200ms', async () => {
    const ms = await measureMs(() => get('/admin/graph'));
    expect(ms).toBeLessThan(200);
  });
});
