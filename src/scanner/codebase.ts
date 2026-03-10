import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtractedMemory } from './markdown.js';
import { parseClaudeMd, parseMemoryMd } from './markdown.js';
import { scanGitHistory } from './git.js';
import { scanSchemaFiles } from './schema.js';

export interface ScanResult {
  memories: ExtractedMemory[];
  summary: {
    rules: number;
    facts: number;
    decisions: number;
    lessons: number;
    preferences: number;
    total: number;
  };
}

/**
 * Orchestrate a full codebase scan to build initial memories.
 */
export function scanCodebase(projectPath: string): ScanResult {
  const allMemories: ExtractedMemory[] = [];

  // 1. Parse CLAUDE.md
  allMemories.push(...parseClaudeMd(projectPath));

  // 2. Parse MEMORY.md
  allMemories.push(...parseMemoryMd(projectPath));

  // 3. Scan git history
  allMemories.push(...scanGitHistory(projectPath));

  // 4. Scan schema/migration files
  allMemories.push(...scanSchemaFiles(projectPath));

  // 5. Extract project identity from package.json
  allMemories.push(...scanPackageJson(projectPath));

  // 6. Scan project structure
  allMemories.push(...scanProjectStructure(projectPath));

  // Build summary
  const summary = {
    rules: 0,
    facts: 0,
    decisions: 0,
    lessons: 0,
    preferences: 0,
    total: allMemories.length,
  };

  for (const m of allMemories) {
    summary[m.category === 'rule' ? 'rules' : m.category === 'fact' ? 'facts' : m.category === 'decision' ? 'decisions' : m.category === 'lesson' ? 'lessons' : 'preferences']++;
  }

  return { memories: allMemories, summary };
}

function scanPackageJson(projectPath: string): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];
  const pkgPath = path.join(projectPath, 'package.json');

  if (!fs.existsSync(pkgPath)) return memories;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    // Project identity
    const parts: string[] = [];
    if (pkg.name) parts.push(`name: ${pkg.name}`);
    if (pkg.description) parts.push(`description: ${pkg.description}`);
    if (pkg.version) parts.push(`version: ${pkg.version}`);

    if (parts.length > 0) {
      memories.push({
        content: `Project identity — ${parts.join(', ')}`,
        category: 'fact',
        tags: ['project', 'identity'],
        source: 'auto-captured',
      });
    }

    // Key dependencies (only major ones)
    const deps = Object.keys(pkg.dependencies ?? {});
    if (deps.length > 0) {
      const frameworks = deps.filter((d) =>
        ['next', 'react', 'vue', 'angular', 'express', 'fastify', 'hono', 'nuxt', 'svelte', 'remix', 'astro'].includes(d)
      );
      if (frameworks.length > 0) {
        memories.push({
          content: `Tech stack frameworks: ${frameworks.join(', ')}`,
          category: 'fact',
          tags: ['tech-stack', 'framework'],
          source: 'auto-captured',
        });
      }

      const databases = deps.filter((d) =>
        ['prisma', 'drizzle-orm', 'better-sqlite3', 'pg', 'mysql2', 'mongoose', 'typeorm', 'knex', '@supabase/supabase-js'].includes(d)
      );
      if (databases.length > 0) {
        memories.push({
          content: `Database libraries: ${databases.join(', ')}`,
          category: 'fact',
          tags: ['tech-stack', 'database'],
          source: 'auto-captured',
        });
      }
    }

    // Scripts
    const scripts = Object.keys(pkg.scripts ?? {});
    if (scripts.length > 0) {
      memories.push({
        content: `Available npm scripts: ${scripts.join(', ')}`,
        category: 'fact',
        tags: ['project', 'scripts'],
        source: 'auto-captured',
      });
    }
  } catch {
    // Invalid package.json
  }

  return memories;
}

function scanProjectStructure(projectPath: string): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];

  try {
    const topLevel = fs.readdirSync(projectPath, { withFileTypes: true });
    const dirs = topLevel
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);

    if (dirs.length > 0) {
      memories.push({
        content: `Project top-level directories: ${dirs.join(', ')}`,
        category: 'fact',
        tags: ['project', 'structure'],
        source: 'auto-captured',
      });
    }
  } catch {
    // Ignore
  }

  return memories;
}
