import { execSync } from 'node:child_process';
import type { ExtractedMemory } from './markdown.js';

/**
 * Read recent git history and extract useful information.
 */
export function scanGitHistory(projectPath: string): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];

  try {
    // Check if it's a git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectPath, stdio: 'pipe' });
  } catch {
    return memories;
  }

  // Get current branch
  try {
    const branch = execSync('git branch --show-current', { cwd: projectPath, stdio: 'pipe' })
      .toString()
      .trim();
    if (branch) {
      memories.push({
        content: `Current git branch: ${branch}`,
        category: 'fact',
        tags: ['git', 'branch'],
        source: 'auto-captured',
      });
    }
  } catch {
    // Ignore
  }

  // Get recent commit messages (last 30)
  try {
    const log = execSync('git log --oneline -30 --format="%s"', { cwd: projectPath, stdio: 'pipe' })
      .toString()
      .trim();

    if (log) {
      const commits = log.split('\n').filter(Boolean);

      // Extract patterns from commit messages
      const patterns = analyzeCommitPatterns(commits);
      if (patterns.length > 0) {
        memories.push({
          content: `Recent development patterns from git history: ${patterns.join('; ')}`,
          category: 'fact',
          tags: ['git', 'history'],
          source: 'auto-captured',
        });
      }

      // Store recent activity summary
      memories.push({
        content: `Last ${commits.length} commits: ${commits.slice(0, 5).join(', ')}`,
        category: 'fact',
        tags: ['git', 'recent-activity'],
        source: 'auto-captured',
      });
    }
  } catch {
    // Ignore
  }

  return memories;
}

function analyzeCommitPatterns(commits: string[]): string[] {
  const patterns: string[] = [];

  // Count commit prefixes (feat:, fix:, chore:, etc.)
  const prefixCounts = new Map<string, number>();
  for (const msg of commits) {
    const match = msg.match(/^(feat|fix|chore|refactor|docs|test|style|build|ci|perf)[\s(:]/i);
    if (match) {
      const prefix = match[1].toLowerCase();
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }

  if (prefixCounts.size > 0) {
    const sorted = Array.from(prefixCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([prefix, count]) => `${prefix} (${count})`);
    patterns.push(`Commit types: ${sorted.join(', ')}`);
  }

  return patterns;
}
