import type Database from 'better-sqlite3';

export type RelationType = 'relates-to' | 'supersedes' | 'contradicts' | 'depends-on';

export interface GraphResult {
  id: string;
  relation_type: RelationType;
  direction: 'outgoing' | 'incoming';
  depth: number;
  score: number; // Graph relevance score
}

// Score weights by relationship type
const RELATION_WEIGHTS: Record<RelationType, number> = {
  'relates-to': 0.6,
  'supersedes': 0.8,
  'contradicts': 0.9,
  'depends-on': 0.7,
};

/**
 * Create a relationship between two memories.
 * For 'relates-to', creates bidirectional edges. Others are directional.
 */
export function createRelationship(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  relationType: RelationType
): void {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO relationships (source_id, target_id, relation_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sourceId, targetId, relationType, now);

  // Bidirectional for relates-to
  if (relationType === 'relates-to') {
    db.prepare(`
      INSERT OR IGNORE INTO relationships (source_id, target_id, relation_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(targetId, sourceId, relationType, now);
  }
}

/**
 * Traverse relationships from a set of memory IDs.
 * Returns connected memories scored by relationship type and distance.
 */
export function graphTraverse(
  db: Database.Database,
  memoryIds: string[],
  maxDepth: number = 1
): GraphResult[] {
  if (memoryIds.length === 0) return [];

  const visited = new Set<string>(memoryIds); // Don't return the seed memories themselves
  const results: GraphResult[] = [];

  let currentIds = memoryIds;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (currentIds.length === 0) break;

    const placeholders = currentIds.map(() => '?').join(', ');
    const depthFactor = 1 / depth; // Decay score by distance

    // Outgoing relationships
    const outgoing = db
      .prepare(
        `SELECT target_id, relation_type FROM relationships
         WHERE source_id IN (${placeholders})`
      )
      .all(...currentIds) as { target_id: string; relation_type: RelationType }[];

    // Incoming relationships
    const incoming = db
      .prepare(
        `SELECT source_id, relation_type FROM relationships
         WHERE target_id IN (${placeholders})`
      )
      .all(...currentIds) as { source_id: string; relation_type: RelationType }[];

    const nextIds: string[] = [];

    for (const rel of outgoing) {
      if (!visited.has(rel.target_id)) {
        visited.add(rel.target_id);
        nextIds.push(rel.target_id);
        results.push({
          id: rel.target_id,
          relation_type: rel.relation_type,
          direction: 'outgoing',
          depth,
          score: (RELATION_WEIGHTS[rel.relation_type] ?? 0.5) * depthFactor,
        });
      }
    }

    for (const rel of incoming) {
      if (!visited.has(rel.source_id)) {
        visited.add(rel.source_id);
        nextIds.push(rel.source_id);
        results.push({
          id: rel.source_id,
          relation_type: rel.relation_type,
          direction: 'incoming',
          depth,
          score: (RELATION_WEIGHTS[rel.relation_type] ?? 0.5) * depthFactor,
        });
      }
    }

    currentIds = nextIds;
  }

  return results;
}

/**
 * Get all relationships for a specific memory.
 */
export function getRelationships(
  db: Database.Database,
  memoryId: string
): { source_id: string; target_id: string; relation_type: RelationType; created_at: string }[] {
  return db
    .prepare(
      `SELECT source_id, target_id, relation_type, created_at FROM relationships
       WHERE source_id = ? OR target_id = ?`
    )
    .all(memoryId, memoryId) as any[];
}
