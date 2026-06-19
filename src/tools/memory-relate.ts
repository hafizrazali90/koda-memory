import type Database from 'better-sqlite3';
import { createRelationship, type RelationType } from '../search/graph.js';

export interface MemoryRelateInput {
  source_id: string;
  target_id: string;
  relation_type: RelationType;
}

export interface MemoryRelateResult {
  message: string;
  bidirectional: boolean;
  superseded?: string;
}

export function memoryRelate(db: Database.Database, userId: string, input: MemoryRelateInput): MemoryRelateResult {
  // Visibility filter: caller can see their own memories + shared + project-scoped
  const VISIBLE = `id = ? AND (user_id = ? OR user_id = 'shared' OR user_id = 'sifututor')`;

  const source = db.prepare(`SELECT id, user_id FROM memories WHERE ${VISIBLE}`).get(input.source_id, userId) as { id: string; user_id: string } | undefined;
  if (!source) {
    throw new Error(`Memory ${input.source_id} not found or not visible`);
  }

  const target = db.prepare(`SELECT id, user_id FROM memories WHERE ${VISIBLE}`).get(input.target_id, userId) as { id: string; user_id: string } | undefined;
  if (!target) {
    throw new Error(`Memory ${input.target_id} not found or not visible`);
  }

  // supersedes marks the target as invalidated — caller must own it unless it's a shared/project memory
  if (input.relation_type === 'supersedes') {
    const targetIsPersonal = target.user_id !== 'shared' && target.user_id !== 'sifututor';
    if (targetIsPersonal && target.user_id !== userId) {
      throw new Error(`Cannot supersede memory ${input.target_id}: owned by another user`);
    }
  }

  createRelationship(db, input.source_id, input.target_id, input.relation_type);

  const bidirectional = input.relation_type === 'relates-to';

  // Bi-temporal supersession: "source supersedes target" end-dates the target.
  // It's marked superseded (excluded from search) and outdated, but kept for history.
  let superseded: string | undefined;
  if (input.relation_type === 'supersedes') {
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE memories SET superseded_at = ?, confidence = 'outdated', updated_at = ? WHERE id = ? AND superseded_at IS NULL"
    ).run(now, now, input.target_id);
    superseded = input.target_id;
  }

  return {
    message: `Created ${input.relation_type} relationship: ${input.source_id} → ${input.target_id}${bidirectional ? ' (bidirectional)' : ''}${superseded ? `. ${superseded} marked superseded (kept for history, excluded from search).` : ''}`,
    bidirectional,
    ...(superseded ? { superseded } : {}),
  };
}
