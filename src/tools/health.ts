import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getDbPath } from '../db/connection.js';

export interface FlaggedMemory {
  id: string;
  content: string;
  flagged_outdated_by: string;
  flagged_outdated_at: string;
}

export interface HealthReport {
  memory: {
    total_memories: number;
    by_category: Record<string, number>;
    by_confidence: Record<string, number>;
    stale_count: number;
    flagged_count: number;
    flagged_for_review: FlaggedMemory[];
    superseded_count: number;
    total_sessions: number;
    total_relationships: number;
  };
  environment: {
    openai_key_set: boolean;
    db_size_kb: number;
    db_path: string;
  };
}

// Every query below is scoped to what `userId` can actually see: their own
// memories, plus 'shared' and 'sifututor' (project-wide). Without this,
// project_health would leak every user's aggregate stats and flagged memory
// content to every other user — unlike every other MCP tool, which already
// enforces this boundary (see memory-search.ts's enrichMemory, for example).
const VISIBILITY = "(user_id = ? OR user_id = 'shared' OR user_id = 'sifututor')";

export function projectHealth(db: Database.Database, userId: string, project?: string): HealthReport {
  const report: HealthReport = {
    memory: {
      total_memories: 0,
      by_category: {},
      by_confidence: {},
      stale_count: 0,
      flagged_count: 0,
      flagged_for_review: [],
      superseded_count: 0,
      total_sessions: 0,
      total_relationships: 0,
    },
    environment: {
      openai_key_set: !!process.env.OPENAI_API_KEY,
      db_size_kb: 0,
      db_path: '',
    },
  };

  const projectClause = project ? ' AND project = ?' : '';
  const projectParams = project ? [project] : [];

  // Memory stats
  const totalMemories = db
    .prepare(`SELECT COUNT(*) as count FROM memories WHERE ${VISIBILITY}${projectClause}`)
    .get(userId, ...projectParams) as { count: number };
  report.memory.total_memories = totalMemories.count;

  const byCategory = db
    .prepare(`SELECT category, COUNT(*) as count FROM memories WHERE ${VISIBILITY}${projectClause} GROUP BY category`)
    .all(userId, ...projectParams) as { category: string; count: number }[];
  for (const row of byCategory) {
    report.memory.by_category[row.category] = row.count;
  }

  const byConfidence = db
    .prepare(`SELECT confidence, COUNT(*) as count FROM memories WHERE ${VISIBILITY}${projectClause} GROUP BY confidence`)
    .all(userId, ...projectParams) as { confidence: string; count: number }[];
  for (const row of byConfidence) {
    report.memory.by_confidence[row.confidence] = row.count;
  }

  // Stale memories (not accessed in 60+ days)
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const stale = db
    .prepare(
      `SELECT COUNT(*) as count FROM memories WHERE ${VISIBILITY}${projectClause} AND last_accessed IS NOT NULL AND last_accessed < ?`
    )
    .get(userId, ...projectParams, sixtyDaysAgo) as { count: number };
  report.memory.stale_count = stale.count;

  // Memories flagged as potentially outdated, awaiting human review
  const flaggedRows = db
    .prepare(
      `SELECT id, content, flagged_outdated_by, flagged_outdated_at
       FROM memories WHERE ${VISIBILITY}${projectClause} AND flagged_outdated_at IS NOT NULL
       ORDER BY flagged_outdated_at DESC`
    )
    .all(userId, ...projectParams) as FlaggedMemory[];
  report.memory.flagged_count = flaggedRows.length;
  report.memory.flagged_for_review = flaggedRows;

  // Superseded memories (fact replaced by a newer one; excluded from search)
  const superseded = db
    .prepare(`SELECT COUNT(*) as count FROM memories WHERE ${VISIBILITY}${projectClause} AND superseded_at IS NOT NULL`)
    .get(userId, ...projectParams) as { count: number };
  report.memory.superseded_count = superseded.count;

  const sessionCount = db
    .prepare(`SELECT COUNT(*) as count FROM sessions WHERE ${VISIBILITY}${projectClause}`)
    .get(userId, ...projectParams) as { count: number };
  report.memory.total_sessions = sessionCount.count;

  // A relationship is visible if its source memory is visible to the caller.
  const relProjectClause = project ? ' AND m.project = ?' : '';
  const relCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM relationships r
       JOIN memories m ON m.id = r.source_id
       WHERE (m.user_id = ? OR m.user_id = 'shared' OR m.user_id = 'sifututor')${relProjectClause}`
    )
    .get(userId, ...projectParams) as { count: number };
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
 *
 * Scoped to what `userId` can see (own + shared + project) — same boundary as
 * every other mutating tool (memory_update, memory_forget). Without this, any
 * user calling project_health({auto_archive:true}) could silently downgrade
 * the confidence of every OTHER user's personal memories.
 */
export function archiveStaleMemories(db: Database.Database, userId: string, project?: string): { archived: number } {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const projectClause = project ? ' AND project = ?' : '';
  const projectParams = project ? [project] : [];

  const result = db
    .prepare(
      `UPDATE memories SET confidence = 'outdated', updated_at = ?
       WHERE ${VISIBILITY}${projectClause}
         AND confidence NOT IN ('outdated', 'confirmed')
         AND COALESCE(human_reviewed_at, last_accessed) IS NOT NULL
         AND COALESCE(human_reviewed_at, last_accessed) < ?`
    )
    .run(new Date().toISOString(), userId, ...projectParams, sixtyDaysAgo);

  return { archived: result.changes };
}
