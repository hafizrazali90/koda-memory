import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getDbPath } from '../db/connection.js';

export interface HealthReport {
  memory: {
    total_memories: number;
    by_category: Record<string, number>;
    by_confidence: Record<string, number>;
    stale_count: number;
    total_sessions: number;
    total_relationships: number;
  };
  environment: {
    openai_key_set: boolean;
    db_size_kb: number;
    db_path: string;
  };
}

export function projectHealth(db: Database.Database): HealthReport {
  const report: HealthReport = {
    memory: {
      total_memories: 0,
      by_category: {},
      by_confidence: {},
      stale_count: 0,
      total_sessions: 0,
      total_relationships: 0,
    },
    environment: {
      openai_key_set: !!process.env.OPENAI_API_KEY,
      db_size_kb: 0,
      db_path: '',
    },
  };

  // Memory stats
  const totalMemories = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
  report.memory.total_memories = totalMemories.count;

  const byCategory = db
    .prepare('SELECT category, COUNT(*) as count FROM memories GROUP BY category')
    .all() as { category: string; count: number }[];
  for (const row of byCategory) {
    report.memory.by_category[row.category] = row.count;
  }

  const byConfidence = db
    .prepare('SELECT confidence, COUNT(*) as count FROM memories GROUP BY confidence')
    .all() as { confidence: string; count: number }[];
  for (const row of byConfidence) {
    report.memory.by_confidence[row.confidence] = row.count;
  }

  // Stale memories (not accessed in 60+ days)
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const stale = db
    .prepare(
      'SELECT COUNT(*) as count FROM memories WHERE last_accessed IS NOT NULL AND last_accessed < ?'
    )
    .get(sixtyDaysAgo) as { count: number };
  report.memory.stale_count = stale.count;

  const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  report.memory.total_sessions = sessionCount.count;

  const relCount = db.prepare('SELECT COUNT(*) as count FROM relationships').get() as { count: number };
  report.memory.total_relationships = relCount.count;

  // DB file size
  const dbPath = getDbPath();
  report.environment.db_path = dbPath;
  try {
    const stats = fs.statSync(dbPath);
    report.environment.db_size_kb = Math.round(stats.size / 1024);
  } catch {
    // File not found
  }

  return report;
}

/**
 * Auto-archive stale memories by marking them 'outdated' (never deletes).
 *
 * Staleness is measured against the most recent human touch — COALESCE(human_reviewed_at,
 * last_accessed) — so a memory a person confirmed recently survives even if it hasn't
 * surfaced in a search. Human-confirmed memories are exempt entirely: a deliberate
 * 'confirmed' verdict should not be undone by passive staleness.
 */
export function archiveStaleMemories(db: Database.Database): { archived: number } {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const result = db
    .prepare(
      `UPDATE memories SET confidence = 'outdated', updated_at = ?
       WHERE confidence NOT IN ('outdated', 'confirmed')
         AND COALESCE(human_reviewed_at, last_accessed) IS NOT NULL
         AND COALESCE(human_reviewed_at, last_accessed) < ?`
    )
    .run(new Date().toISOString(), sixtyDaysAgo);

  return { archived: result.changes };
}
