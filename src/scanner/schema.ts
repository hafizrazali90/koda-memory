import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtractedMemory } from './markdown.js';

/**
 * Scan migration/schema files and extract table/column information as memories.
 */
export function scanSchemaFiles(projectPath: string): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];

  // Common migration directories
  const migrationDirs = [
    'migrations',
    'src/migrations',
    'db/migrations',
    'prisma/migrations',
    'drizzle',
    'supabase/migrations',
  ];

  for (const dir of migrationDirs) {
    const fullPath = path.join(projectPath, dir);
    if (!fs.existsSync(fullPath)) continue;

    const files = findSqlFiles(fullPath);
    for (const file of files) {
      const tables = extractTablesFromSql(file);
      if (tables.length > 0) {
        memories.push({
          content: `Database tables from ${path.relative(projectPath, file)}: ${tables.join(', ')}`,
          category: 'fact',
          tags: ['schema', 'database'],
          source: 'auto-captured',
        });
      }
    }
  }

  // Check for Prisma schema
  const prismaPath = path.join(projectPath, 'prisma', 'schema.prisma');
  if (fs.existsSync(prismaPath)) {
    const models = extractPrismaModels(prismaPath);
    if (models.length > 0) {
      memories.push({
        content: `Prisma models: ${models.join(', ')}`,
        category: 'fact',
        tags: ['schema', 'prisma', 'database'],
        source: 'auto-captured',
      });
    }
  }

  // Check for Drizzle schema
  const drizzlePaths = ['src/db/schema.ts', 'src/schema.ts', 'drizzle/schema.ts'];
  for (const dp of drizzlePaths) {
    const fullPath = path.join(projectPath, dp);
    if (fs.existsSync(fullPath)) {
      memories.push({
        content: `Drizzle schema file found at: ${dp}`,
        category: 'fact',
        tags: ['schema', 'drizzle', 'database'],
        source: 'auto-captured',
      });
    }
  }

  return memories;
}

function findSqlFiles(dir: string): string[] {
  const files: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findSqlFiles(fullPath));
      } else if (entry.name.endsWith('.sql')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Ignore permission errors
  }

  return files;
}

function extractTablesFromSql(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const tables: string[] = [];
    const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
    let match;
    while ((match = regex.exec(content)) !== null) {
      tables.push(match[1]);
    }
    return tables;
  } catch {
    return [];
  }
}

function extractPrismaModels(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const models: string[] = [];
    const regex = /^model\s+(\w+)\s*\{/gm;
    let match;
    while ((match = regex.exec(content)) !== null) {
      models.push(match[1]);
    }
    return models;
  } catch {
    return [];
  }
}
