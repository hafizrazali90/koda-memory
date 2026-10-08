/**
 * FTS query safety (08/10/2026 outage): memory text with hyphens, slashes,
 * dots or apostrophes made the FTS5 query invalid, and the fallback turned
 * every word into a prefix term (even one-letter stubs such as `a*`). One
 * validation-scheduler search then took 60 to 90+ seconds on the production
 * database and froze the single-threaded server for every agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../db/connection.js';
import { buildFallbackFtsQuery, ftsSearch, MAX_QUERY_TERMS, sanitizeFtsQuery } from './fts.js';

const OUTAGE_TEXT =
  "Hafiz decision 08/10/2026 (ripple-suite #1608, changes BR-097): if a tutor applied to a Tutor Request in the tutor app, " +
  "they count as able to support the child's special need. Implemented in computeCandidateReadiness via support.tutorApplied " +
  "(pending/approved application). A staff-recorded 'Cannot support' still blocks; release/<issue> --code-only a b c d e f.";

function termsOf(query: string): string[] {
  return (query.match(/"[^"]*"|[^\s"]+/g) ?? []).filter((t) => t !== 'OR');
}

describe('FTS query builders', () => {
  it('quotes every generated term so punctuation can never break FTS5 syntax', () => {
    const q = sanitizeFtsQuery(OUTAGE_TEXT, 'OR');
    for (const term of termsOf(q)) {
      expect(term).toMatch(/^"[\p{L}\p{N}_ ]+"$/u);
    }
  });

  it('caps and de-duplicates terms for long text', () => {
    const q = sanitizeFtsQuery(`${OUTAGE_TEXT} ${OUTAGE_TEXT} ${OUTAGE_TEXT}`, 'OR');
    const terms = termsOf(q);
    expect(terms.length).toBeLessThanOrEqual(MAX_QUERY_TERMS);
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length);
  });

  it('keeps a short explicit phrase search and an explicit prefix from the user', () => {
    expect(sanitizeFtsQuery('"exact phrase"')).toBe('"exact phrase"');
    expect(sanitizeFtsQuery('pay* invoice')).toBe('pay* "invoice"');
  });

  it('fallback never generates prefix terms shorter than four characters', () => {
    const q = buildFallbackFtsQuery(OUTAGE_TEXT);
    const prefixes = termsOf(q).filter((t) => t.endsWith('*'));
    for (const p of prefixes) expect(p.length - 1).toBeGreaterThanOrEqual(4);
    expect(termsOf(q).length).toBeLessThanOrEqual(MAX_QUERY_TERMS);
  });
});

describe('ftsSearch on punctuation-heavy memory text', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-fts-'));
    db = openDatabase({ dbPath: path.join(tmpDir, 'brain.db') });
    const seed = db.prepare(
      `INSERT INTO memories (id, project, user_id, category, content, source, created_at, created_by)
       VALUES (?, 'p', 'alice', 'fact', ?, 'user-stated', ?, 'alice')`
    );
    const fts = db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)');
    const now = new Date().toISOString();
    const rows: Array<[string, string]> = [
      ['mem_target', 'Tutor applied in the tutor app counts as able to support the special need (BR-097).'],
      ['mem_other', 'Ripple invoices are paid through FIUU and recorded in SIMS.'],
    ];
    for (let i = 0; i < 300; i++) rows.push([`mem_noise_${i}`, `alpha${i} beta${i} assorted words about area ${i}`]);
    for (const [id, content] of rows) {
      seed.run(id, content, now);
      fts.run(id, content, null, '');
    }
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the related memory quickly instead of falling into a prefix explosion', () => {
    const started = Date.now();
    const results = ftsSearch(db, OUTAGE_TEXT, { limit: 5, userId: 'alice', operator: 'OR' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(results[0]?.id).toBe('mem_target');
  });

  it('handles memory text that contains double quotes', () => {
    const text = 'The cleanup note says "Closed: handed over to Customer Facing" for the tutor app (BR-097).';
    expect(() => ftsSearch(db, text, { limit: 5, userId: 'alice', operator: 'OR' })).not.toThrow();
    expect(ftsSearch(db, text, { limit: 5, userId: 'alice', operator: 'OR' })[0]?.id).toBe('mem_target');
  });

  it('drives the plan from the FTS index even for the team-wide user', () => {
    // 08/10/2026: with userId 'sifututor' SQLite walked memories by user_id
    // and re-ran the full-text MATCH per row (19 s on production data).
    const seen: string[] = [];
    const spy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            seen.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    // Production-like statistics: many users, few team-wide rows, ANALYZE.
    const seed = db.prepare(
      `INSERT INTO memories (id, project, user_id, category, content, source, created_at, created_by)
       VALUES (?, 'p', ?, 'fact', ?, 'user-stated', ?, 'x')`
    );
    const fts = db.prepare('INSERT INTO memories_fts (id, content, why, tags) VALUES (?, ?, ?, ?)');
    const now = new Date().toISOString();
    for (let i = 0; i < 2000; i++) {
      const id = `mem_stat_${i}`;
      const content = `tutor support request number ${i} app decision`;
      seed.run(id, i % 400 === 0 ? 'sifututor' : `user${i % 50}`, content, now);
      fts.run(id, content, null, '');
    }
    db.exec('ANALYZE');
    ftsSearch(spy, OUTAGE_TEXT, { limit: 5, userId: 'sifututor', operator: 'OR' });
    const searchSql = seen.find((sql) => sql.includes('memories_fts MATCH'));
    expect(searchSql).toBeDefined();
    // CROSS JOIN pins the join order in SQLite; ANALYZE statistics on the
    // production database otherwise chose the per-row MATCH plan.
    expect(searchSql).toMatch(/memories_fts f\s+CROSS JOIN memories m/);
    const q = sanitizeFtsQuery(OUTAGE_TEXT, 'OR');
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${searchSql}`)
      .all(q, 'sifututor', 5) as Array<{ detail: string }>;
    expect(plan[0]?.detail).toMatch(/^SCAN f VIRTUAL TABLE/);
  });
});

