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
}

export function memoryRelate(db: Database.Database, input: MemoryRelateInput): MemoryRelateResult {
  // Validate both memories exist
  const source = db.prepare('SELECT id FROM memories WHERE id = ?').get(input.source_id);
  if (!source) {
    throw new Error(`Memory ${input.source_id} not found`);
  }

  const target = db.prepare('SELECT id FROM memories WHERE id = ?').get(input.target_id);
  if (!target) {
    throw new Error(`Memory ${input.target_id} not found`);
  }

  createRelationship(db, input.source_id, input.target_id, input.relation_type);

  const bidirectional = input.relation_type === 'relates-to';

  return {
    message: `Created ${input.relation_type} relationship: ${input.source_id} → ${input.target_id}${bidirectional ? ' (bidirectional)' : ''}`,
    bidirectional,
  };
}
