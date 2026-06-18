/**
 * Phase 3A — Load Test
 *
 * Seeds a large number of memories into an isolated DB, then measures
 * FTS search latency at P50 / P95 / P99. Target: P99 < 100ms for 10k rows.
 *
 * Embeddings and LLM processing are disabled (no OPENAI_API_KEY in env) so
 * this purely measures SQLite FTS5 throughput — the hot path for every query.
 *
 * Run standalone: npx vitest run src/load.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { openDatabase } from './db/connection.js';
import { memoryStore } from './tools/memory-store.js';
import { ftsSearch } from './search/fts.js';
import type Database from 'better-sqlite3';

// ---- Corpus config -------------------------------------------------------

const SEED_COUNT = 10_000;
// A realistic corpus: short memories drawn from plausible dev-context topics
const TOPICS = [
  'authentication flow', 'database migration', 'payment gateway integration',
  'session cookie', 'Laravel middleware', 'API endpoint', 'Eloquent model',
  'React component', 'TypeScript interface', 'deployment pipeline',
  'staging environment', 'soft delete', 'foreign key constraint',
  'invoice status', 'tutor verification', 'parent subscription',
  'billing cycle', 'FIUU callback', 'Cloudflare DNS', 'SSH alias',
  'cron job', 'queue worker', 'Redis cache', 'rate limiter',
  'CORS header', 'Sanctum token', 'route middleware', 'form request',
  'Inertia.js', 'Tailwind CSS', 'Vite bundler', 'React Native',
];

const CATEGORIES = ['decision', 'lesson', 'rule', 'fact', 'preference'] as const;
const USERS = ['hafiz', 'ali', 'sara', 'faiz'];

function makeSeed(i: number) {
  const topic = TOPICS[i % TOPICS.length];
  const cat = CATEGORIES[i % CATEGORIES.length];
  const user = USERS[i % USERS.length];
  return {
    content: `Memory ${i}: learned that the ${topic} should always be reviewed when making changes to module ${(i % 50) + 1}. This rule was discovered after a production incident in sprint ${(i % 20) + 1}.`,
    category: cat,
    why: `Prevents regression in the ${topic} area for module ${(i % 50) + 1}`,
    tags: [topic.split(' ')[0], `module-${(i % 50) + 1}`, cat],
    source: 'auto-captured' as const,
    user,
  };
}

// ---- Latency helpers -------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ---- Suite -----------------------------------------------------------------

describe('Load test — FTS search at 10k memories', () => {
  const testDir = path.join(os.tmpdir(), `koda-load-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });

    // Bulk-insert via transactions for speed (5k per tx)
    const BATCH = 5_000;
    for (let start = 0; start < SEED_COUNT; start += BATCH) {
      const end = Math.min(start + BATCH, SEED_COUNT);
      const stores: Promise<any>[] = [];
      for (let i = start; i < end; i++) {
        const s = makeSeed(i);
        stores.push(memoryStore(db, 'loadtest', s.user, {
          content: s.content,
          category: s.category,
          why: s.why,
          tags: s.tags,
          source: s.source,
        }));
      }
      await Promise.all(stores);
    }
  }, 120_000); // seeding 10k takes ~60s on a slow machine

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it(`seeded exactly ${SEED_COUNT} memories`, () => {
    const row = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(row.c).toBe(SEED_COUNT);
  });

  it('FTS search P99 < 100ms over 10k rows (50 queries)', () => {
    const queries = [
      'authentication flow middleware',
      'database migration soft delete',
      'payment gateway FIUU callback',
      'staging deployment pipeline',
      'Eloquent model foreign key',
      'React Native component',
      'Laravel API endpoint Sanctum',
      'TypeScript interface strict',
      'invoice billing cycle',
      'tutor verification subscription',
    ];

    const durations: number[] = [];
    const RUNS = 5; // run each query 5× = 50 measurements

    for (let run = 0; run < RUNS; run++) {
      for (const q of queries) {
        const start = process.hrtime.bigint();
        ftsSearch(db, q, { userId: 'hafiz', limit: 10 });
        const end = process.hrtime.bigint();
        durations.push(Number(end - start) / 1_000_000); // ns → ms
      }
    }

    durations.sort((a, b) => a - b);
    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);

    console.log(`\n  FTS latency over ${SEED_COUNT} memories (${durations.length} measurements):`);
    console.log(`    P50 = ${p50.toFixed(2)}ms`);
    console.log(`    P95 = ${p95.toFixed(2)}ms`);
    console.log(`    P99 = ${p99.toFixed(2)}ms`);

    expect(p99).toBeLessThan(100); // hard SLA
    expect(p50).toBeLessThan(20);  // typical case should be very fast
  });

  it('FTS index is healthy — words common to all memories return results for hafiz', () => {
    // "production", "sprint", "learned" appear in every seeded memory's content
    // so hafiz (25% of 10k = 2500 memories) must always return results.
    // Note: topic-specific words (React Native, invoice) may belong to other users
    // when user assignment cycles are not coprime with topic count — verified by design.
    for (const q of ['production incident', 'sprint', 'learned reviewed']) {
      const results = ftsSearch(db, q, { userId: 'hafiz', limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    }
  });

  it('visibility filter works at scale — hafiz cannot see ali-only memories', async () => {
    // Use memoryStore (not raw SQL) so the FTS trigger fires correctly.
    // Plain word marker — no hyphens/numbers (FTS5 AND query needs clean tokens).
    const marker = 'xyzquuxprivateforzalionly';
    await memoryStore(db, 'vistest', 'ali', {
      content: `ali private secret ${marker} confidential internal note`,
      category: 'fact',
    });

    const asHafiz = ftsSearch(db, marker, { userId: 'hafiz', limit: 5 });
    const asAli   = ftsSearch(db, marker, { userId: 'ali',   limit: 5 });

    expect(asHafiz.find(r => r.content.includes(marker))).toBeUndefined();
    expect(asAli.find(r => r.content.includes(marker))).toBeDefined();
  });
});
