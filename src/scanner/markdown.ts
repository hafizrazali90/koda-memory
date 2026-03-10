import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExtractedMemory {
  content: string;
  category: 'rule' | 'preference' | 'fact' | 'decision' | 'lesson';
  why?: string;
  tags: string[];
  source: 'auto-captured';
}

/**
 * Parse CLAUDE.md and extract rules, preferences, and facts as memories.
 */
export function parseClaudeMd(projectPath: string): ExtractedMemory[] {
  const filePath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const memories: ExtractedMemory[] = [];
  let currentSection = '';

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Track sections
    if (trimmed.startsWith('#')) {
      currentSection = trimmed.replace(/^#+\s*/, '').toLowerCase();
      continue;
    }

    // Skip empty lines
    if (!trimmed || trimmed === '---') continue;

    // Extract bullet points as individual memories
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const text = trimmed.replace(/^[-*]\s+/, '');
      if (text.length < 10) continue; // Skip very short items

      const category = inferCategory(currentSection, text);
      memories.push({
        content: text,
        category,
        tags: ['claude-md', inferTag(currentSection)].filter(Boolean),
        source: 'auto-captured',
      });
    }
  }

  return memories;
}

/**
 * Parse MEMORY.md and extract existing memories.
 */
export function parseMemoryMd(projectPath: string): ExtractedMemory[] {
  // Check multiple possible locations
  const possiblePaths = [
    path.join(projectPath, 'MEMORY.md'),
    path.join(projectPath, '.claude', 'MEMORY.md'),
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      return parseMarkdownFile(filePath);
    }
  }

  return [];
}

function parseMarkdownFile(filePath: string): ExtractedMemory[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const memories: ExtractedMemory[] = [];
  let currentSection = '';

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#')) {
      currentSection = trimmed.replace(/^#+\s*/, '').toLowerCase();
      continue;
    }

    if (!trimmed || trimmed === '---') continue;

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const text = trimmed.replace(/^[-*]\s+/, '');
      if (text.length < 10) continue;

      memories.push({
        content: text,
        category: inferCategory(currentSection, text),
        tags: ['memory-md', inferTag(currentSection)].filter(Boolean),
        source: 'auto-captured',
      });
    }
  }

  return memories;
}

function inferCategory(section: string, text: string): ExtractedMemory['category'] {
  const lower = text.toLowerCase();

  if (section.includes('rule') || section.includes('convention') || section.includes('requirement')) return 'rule';
  if (section.includes('decision') || section.includes('architecture')) return 'decision';
  if (section.includes('lesson') || section.includes('learned') || section.includes('mistake')) return 'lesson';
  if (section.includes('preference') || section.includes('style')) return 'preference';

  if (lower.includes('never') || lower.includes('always') || lower.includes('must') || lower.includes('do not'))
    return 'rule';
  if (lower.includes('decided') || lower.includes('chose') || lower.includes('use ')) return 'decision';
  if (lower.includes('learned') || lower.includes('discovered') || lower.includes('realized')) return 'lesson';
  if (lower.includes('prefer') || lower.includes('like to')) return 'preference';

  return 'fact';
}

function inferTag(section: string): string {
  if (!section) return '';
  // Clean up section name for use as tag
  return section.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
