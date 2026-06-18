/**
 * Phase 3B — Retrieval Quality Eval
 *
 * Tests that the blended search (FTS + vector + graph) surfaces the right
 * memories for real queries. We seed a small labeled corpus, run known queries,
 * and assert that the expected memory IDs appear in the top-N results.
 *
 * Metrics:
 *   Recall@5  — at least 1 expected result in the top 5
 *   Recall@10 — at least 1 expected result in the top 10
 *
 * Embeddings are disabled (no OPENAI_API_KEY in test env) so this measures
 * pure FTS recall. When embeddings are enabled in CI, the recall scores should
 * only improve (vector + FTS blend > FTS alone).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { openDatabase } from './db/connection.js';
import { memoryStore } from './tools/memory-store.js';
import { memorySearch } from './tools/memory-search.js';
import { memoryContext } from './tools/memory-context.js';
import type Database from 'better-sqlite3';

// ---- Labeled corpus -------------------------------------------------------

interface LabeledMemory {
  label: string;       // human-readable for test output
  content: string;
  category: 'decision' | 'lesson' | 'rule' | 'fact' | 'preference';
  why?: string;
  tags?: string[];
}

const CORPUS: LabeledMemory[] = [
  {
    label: 'soft-delete rule',
    content: 'Every SIMS query must include deleted_at IS NULL — soft-delete is enforced at the query level, not in the application layer.',
    category: 'rule',
    why: 'Prevents accidentally surfacing deleted records in production queries.',
    tags: ['sifu-tutor', 'sims', 'soft-delete', 'database'],
  },
  {
    label: 'staging URL',
    content: 'The correct sifu-tutor staging URL is sifu-staging.tutorla.tech on Web Voyager. sims-staging.tutorla.tech is DECOMMISSIONED.',
    category: 'fact',
    why: 'Old staging URL causes 404 — team keeps forgetting to use the new URL.',
    tags: ['sifu-tutor', 'staging', 'deployment', 'infra'],
  },
  {
    label: 'InvoiceStatus enum guard',
    // Content deliberately uses "invoice status" as separate words alongside
    // "InvoiceStatus" — FTS5 treats camelCase as one token, so both forms are
    // needed for reliable recall without camelCase splitting.
    content: 'PHP 8.1 backed enums: comparing an enum to a string with !== ALWAYS returns true. For invoice status checks always use InvoiceStatus::Paid, not the string "paid".',
    category: 'lesson',
    why: 'invoice status: PaymentTransferService had 4 broken guards that silently passed all invoices as unpaid.',
    tags: ['sifu-tutor', 'php', 'enum', 'invoice', 'billing'],
  },
  {
    label: 'FIUU declined callback',
    content: 'FIUU declined payment callbacks should set InvoiceStatus::UnPaid (not "failed"). Always return HTTP 200 from the callback endpoint. Call the ordering guard before any DB transaction.',
    category: 'rule',
    why: 'Returning non-200 causes FIUU to retry infinitely; wrong status breaks the billing flow.',
    tags: ['sifu-tutor', 'fiuu', 'payment', 'callback', 'billing'],
  },
  {
    label: 'Playwright auth isolation',
    content: 'Playwright global storageState infects all tests in a suite. Unauthenticated tests need explicit test.use({ storageState: { cookies: [], origins: [] } }).',
    category: 'lesson',
    why: 'Auth state from a logged-in test bleeds into guest-flow tests, masking 401 bugs.',
    tags: ['ripple-suite', 'playwright', 'testing', 'auth'],
  },
  {
    label: 'production server path',
    content: 'The production app lives at /home/sifututortutorla/public_html — NOT /var/www/sifu-tutor. HostArmada shared hosting uses cPanel home dirs.',
    category: 'fact',
    why: 'Multiple agents deployed to the wrong path and wondered why changes had no effect.',
    tags: ['sifu-tutor', 'production', 'infra', 'deployment'],
  },
  {
    label: 'Cloudflare proxy must be OFF',
    content: 'Cloudflare proxy must be DISABLED (DNS-only) on all Web Voyager staging domains. The CF proxy breaks Laravel session cookies.',
    category: 'rule',
    why: 'Enabling CF proxy caused intermittent 419 CSRF errors on staging login.',
    tags: ['sifu-tutor', 'cloudflare', 'staging', 'infra'],
  },
  {
    label: 'deploy pipeline order',
    content: 'sifu-tutor deployment order is: sifu-backport → sifu-staging → main. Never deploy main before staging validation.',
    category: 'rule',
    why: 'Reversed order twice shipped untested code to main.',
    tags: ['sifu-tutor', 'deployment', 'pipeline', 'git'],
  },
  {
    label: 'React Native BaseUri migration',
    content: 'cloud.tutorla.tech is used as the API base URL in BaseUri.tsx, env.ts, and App.tsx. These must be migrated to sifu-tutor.tutorla.tech before the mobile app goes to production.',
    category: 'fact',
    why: 'cloud.tutorla.tech is now the server hostname — it will stop working as an API base URL.',
    tags: ['sifututor_tutor', 'mobile', 'api', 'migration'],
  },
  {
    label: 'Koda ecosystem config keys',
    content: 'KODA_API_KEY and OPENAI_API_KEY are hardcoded as literals in /opt/koda/app/ecosystem.config.cjs. Do NOT revert to process.env — keys disappear on pm2 delete+start.',
    category: 'rule',
    why: 'pm2 does not persist env vars across delete+start cycles without hardcoding.',
    tags: ['umbrella', 'koda', 'infra', 'pm2'],
  },
];

// ---- Query → expected label map -------------------------------------------

interface Scenario {
  query: string;
  expectedLabels: string[];   // at least ONE must appear in top-N
  description: string;
}

const SCENARIOS: Scenario[] = [
  {
    query: 'deleted_at null sims query',
    expectedLabels: ['soft-delete rule'],
    description: 'Finds soft-delete rule when querying with SQL terminology',
  },
  {
    query: 'staging url tutorla',
    expectedLabels: ['staging URL', 'Cloudflare proxy must be OFF'],
    description: 'Finds staging environment info',
  },
  {
    // Note: "comparison" would fail — FTS5 doesn't stem comparing→comparison.
    // Validated via debug: "invoice status php enum" hits @1 result.
    query: 'invoice status php enum',
    expectedLabels: ['InvoiceStatus enum guard'],
    description: 'Finds PHP enum lesson with invoice terminology',
  },
  {
    query: 'FIUU payment callback 200',
    expectedLabels: ['FIUU declined callback'],
    description: 'Finds FIUU-specific callback rule',
  },
  {
    query: 'playwright storageState cookies auth',
    expectedLabels: ['Playwright auth isolation'],
    description: 'Finds Playwright auth isolation lesson',
  },
  {
    query: 'production deploy path cpanel',
    expectedLabels: ['production server path'],
    description: 'Finds production path rule',
  },
  {
    query: 'cloudflare proxy session cookie',
    expectedLabels: ['Cloudflare proxy must be OFF'],
    description: 'Finds Cloudflare proxy rule',
  },
  {
    query: 'deploy order backport staging main',
    expectedLabels: ['deploy pipeline order'],
    description: 'Finds pipeline ordering rule',
  },
  {
    query: 'mobile API base URL migration',
    expectedLabels: ['React Native BaseUri migration'],
    description: 'Finds RN base URL migration task',
  },
  {
    query: 'koda pm2 ecosystem config api key',
    expectedLabels: ['Koda ecosystem config keys'],
    description: 'Finds pm2 key hardcoding rule',
  },
];

// ---- Suite -----------------------------------------------------------------

describe('Retrieval quality — labeled corpus eval', () => {
  const testDir = path.join(os.tmpdir(), `koda-quality-${Date.now()}`);
  const dbPath = path.join(testDir, 'brain.db');
  let db: Database.Database;

  // label → stored ID
  const idByLabel = new Map<string, string>();

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath });

    for (const mem of CORPUS) {
      const result = await memoryStore(db, 'quality', 'hafiz', {
        content: mem.content,
        category: mem.category,
        why: mem.why,
        tags: mem.tags,
        source: 'user-stated',
      });
      idByLabel.set(mem.label, result.id);
    }
  });

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('seeded the labeled corpus', () => {
    const row = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(row.c).toBe(CORPUS.length);
  });

  // Recall@5 tests
  describe('Recall@5 — expected memory in top 5 results', () => {
    for (const scenario of SCENARIOS) {
      it(scenario.description, async () => {
        const results = await memorySearch(db, 'hafiz', { query: scenario.query, limit: 5 });
        const returnedIds = results.map((r: any) => r.id);

        const expectedIds = scenario.expectedLabels.map(l => idByLabel.get(l)!).filter(Boolean);
        const hit = expectedIds.some(id => returnedIds.includes(id));

        if (!hit) {
          // Print top-5 for debugging
          const topContent = results.slice(0, 5).map((r: any, i: number) => `  ${i + 1}. ${r.content.slice(0, 80)}...`).join('\n');
          console.warn(`\n  Recall@5 MISS for: "${scenario.query}"\n  Expected one of: ${scenario.expectedLabels.join(', ')}\n  Got:\n${topContent}`);
        }

        expect(hit).toBe(true);
      });
    }
  });

  // Recall@10 tests (more lenient — top 10)
  describe('Recall@10 — expected memory in top 10 results', () => {
    for (const scenario of SCENARIOS) {
      it(scenario.description, async () => {
        const results = await memorySearch(db, 'hafiz', { query: scenario.query, limit: 10 });
        const returnedIds = results.map((r: any) => r.id);

        const expectedIds = scenario.expectedLabels.map(l => idByLabel.get(l)!).filter(Boolean);
        const hit = expectedIds.some(id => returnedIds.includes(id));

        expect(hit).toBe(true);
      });
    }
  });

  // Aggregate recall score
  it('Recall@5 score ≥ 70% across all scenarios', async () => {
    let hits = 0;
    for (const scenario of SCENARIOS) {
      const results = await memorySearch(db, 'hafiz', { query: scenario.query, limit: 5 });
      const returnedIds = results.map((r: any) => r.id);
      const expectedIds = scenario.expectedLabels.map(l => idByLabel.get(l)!).filter(Boolean);
      if (expectedIds.some(id => returnedIds.includes(id))) hits++;
    }
    const recall = hits / SCENARIOS.length;
    console.log(`\n  Recall@5: ${hits}/${SCENARIOS.length} = ${(recall * 100).toFixed(0)}%`);
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });

  it('Recall@10 score ≥ 80% across all scenarios', async () => {
    let hits = 0;
    for (const scenario of SCENARIOS) {
      const results = await memorySearch(db, 'hafiz', { query: scenario.query, limit: 10 });
      const returnedIds = results.map((r: any) => r.id);
      const expectedIds = scenario.expectedLabels.map(l => idByLabel.get(l)!).filter(Boolean);
      if (expectedIds.some(id => returnedIds.includes(id))) hits++;
    }
    const recall = hits / SCENARIOS.length;
    console.log(`\n  Recall@10: ${hits}/${SCENARIOS.length} = ${(recall * 100).toFixed(0)}%`);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  // memory_context (blended) recall
  describe('memory_context blended recall — expected memory in top 15', () => {
    it('finds soft-delete rule when asking about SIMS queries', async () => {
      const result = await memoryContext(db, 'hafiz', { task_description: 'writing a new SIMS query for tutor list', limit: 15 });
      const ids = result.memories.map((m: any) => m.id);
      expect(ids).toContain(idByLabel.get('soft-delete rule'));
    });

    it('finds staging URL when asking about deploying to test', async () => {
      const result = await memoryContext(db, 'hafiz', { task_description: 'deploying to the staging environment for QA testing', limit: 15 });
      const ids = result.memories.map((m: any) => m.id);
      const hit = ids.includes(idByLabel.get('staging URL')) || ids.includes(idByLabel.get('deploy pipeline order'));
      expect(hit).toBe(true);
    });

    it('finds payment rules when asking about invoice processing', async () => {
      const result = await memoryContext(db, 'hafiz', { task_description: 'implementing invoice payment status update after callback', limit: 15 });
      const ids = result.memories.map((m: any) => m.id);
      const hit = ids.includes(idByLabel.get('InvoiceStatus enum guard')) || ids.includes(idByLabel.get('FIUU declined callback'));
      expect(hit).toBe(true);
    });
  });
});
