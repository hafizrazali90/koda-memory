import type Database from 'better-sqlite3';
import { scanCodebase } from '../scanner/codebase.js';
import { memoryStore } from './memory-store.js';

export interface MemoryInitResult {
  project_path: string;
  summary: string;
  counts: {
    rules: number;
    facts: number;
    decisions: number;
    lessons: number;
    preferences: number;
    total: number;
  };
  embedded: number;
  errors: number;
}

export async function memoryInit(db: Database.Database, projectPath: string): Promise<MemoryInitResult> {
  const project = projectPath.split(/[\\/]/).pop() || 'unknown';

  // Check if already initialized
  const existingCount = db.prepare('SELECT COUNT(*) as count FROM memories WHERE project = ?').get(project) as {
    count: number;
  };

  if (existingCount.count > 0) {
    return {
      project_path: projectPath,
      summary: `Project already has ${existingCount.count} memories. Use memory_store to add more or memory_forget to clear.`,
      counts: { rules: 0, facts: 0, decisions: 0, lessons: 0, preferences: 0, total: 0 },
      embedded: 0,
      errors: 0,
    };
  }

  // Scan the codebase
  const scan = scanCodebase(projectPath);

  // Store each extracted memory
  let embedded = 0;
  let errors = 0;

  for (const memory of scan.memories) {
    try {
      const result = await memoryStore(db, project, {
        content: memory.content,
        category: memory.category,
        why: memory.why,
        tags: memory.tags,
        source: memory.source,
      });
      if (result.embedded) embedded++;
    } catch {
      errors++;
    }
  }

  return {
    project_path: projectPath,
    summary: `Learned ${scan.summary.total} memories from ${project}: ${scan.summary.rules} rules, ${scan.summary.facts} facts, ${scan.summary.decisions} decisions, ${scan.summary.lessons} lessons, ${scan.summary.preferences} preferences`,
    counts: scan.summary,
    embedded,
    errors,
  };
}
