import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConnection, closeAllConnections } from './db/connection.js';
import { memoryStore } from './tools/memory-store.js';
import { memoryRecall } from './tools/memory-recall.js';
import { memorySearch } from './tools/memory-search.js';
import { memoryRelate } from './tools/memory-relate.js';
import { memoryContext } from './tools/memory-context.js';
import { memoryUpdate } from './tools/memory-update.js';
import { memoryForget } from './tools/memory-forget.js';
import { sessionStart, sessionEnd, sessionList } from './tools/session.js';
import { memoryInit } from './tools/memory-init.js';
import { projectHealth, archiveStaleMemories } from './tools/health.js';

const projectPath = process.env.KODA_PROJECT_PATH || process.cwd();

const server = new McpServer({
  name: 'koda-memory',
  version: '0.1.0',
});

// memory_store - Save a new memory
server.tool(
  'memory_store',
  'Save a new memory (decision, lesson, rule, preference, or fact)',
  {
    content: z.string().describe('The memory content'),
    category: z.enum(['decision', 'lesson', 'rule', 'preference', 'fact']).describe('Memory category'),
    why: z.string().optional().describe('Why this matters'),
    tags: z.array(z.string()).optional().describe('Tags for filtering'),
    source: z.enum(['user-stated', 'auto-captured', 'correction']).optional().describe('How this was captured'),
  },
  async (params) => {
    const db = getConnection(projectPath);
    const project = projectPath.split(/[\\/]/).pop() || 'unknown';
    const result = await memoryStore(db, project, params);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// memory_recall - Get a specific memory by ID
server.tool(
  'memory_recall',
  'Retrieve a specific memory by its ID',
  {
    id: z.string().describe('Memory ID (e.g. mem_0001)'),
  },
  async (params) => {
    const db = getConnection(projectPath);
    const memory = memoryRecall(db, params.id);
    if (!memory) {
      return {
        content: [{ type: 'text' as const, text: `Memory ${params.id} not found` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(memory, null, 2) }],
    };
  }
);

// memory_search - Search memories by keyword, category, tags
server.tool(
  'memory_search',
  'Search memories using keyword search with optional category and tag filters',
  {
    query: z.string().describe('Search query (supports phrases and prefix matching)'),
    category: z.enum(['decision', 'lesson', 'rule', 'preference', 'fact']).optional().describe('Filter by category'),
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    limit: z.number().optional().describe('Max results (default 10)'),
  },
  async (params) => {
    const db = getConnection(projectPath);
    const results = await memorySearch(db, params);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// memory_context - Smart multi-search for task context
server.tool(
  'memory_context',
  'Get relevant memories for a task using blended keyword + semantic + graph search',
  {
    task_description: z.string().describe('What you are working on'),
    limit: z.number().optional().describe('Max results (default 15)'),
    graph_depth: z.number().min(1).max(3).optional().describe('Graph traversal depth (default 1, max 3)'),
  },
  async (params) => {
    const db = getConnection(projectPath);
    const result = await memoryContext(db, params);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// memory_relate - Create relationships between memories
server.tool(
  'memory_relate',
  'Create a relationship between two memories (relates-to, supersedes, contradicts, depends-on)',
  {
    source_id: z.string().describe('Source memory ID'),
    target_id: z.string().describe('Target memory ID'),
    relation_type: z
      .enum(['relates-to', 'supersedes', 'contradicts', 'depends-on'])
      .describe('Type of relationship'),
  },
  async (params) => {
    try {
      const db = getConnection(projectPath);
      const result = memoryRelate(db, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: error.message }],
        isError: true,
      };
    }
  }
);

// memory_update - Modify an existing memory
server.tool(
  'memory_update',
  'Update an existing memory (content, why, tags, confidence, or source)',
  {
    id: z.string().describe('Memory ID to update'),
    content: z.string().optional().describe('New content'),
    why: z.string().optional().describe('New rationale'),
    tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
    confidence: z.enum(['confirmed', 'inferred', 'outdated']).optional().describe('New confidence level'),
    source: z.enum(['user-stated', 'auto-captured', 'correction']).optional().describe('How this was captured'),
  },
  async (params) => {
    try {
      const db = getConnection(projectPath);
      const result = await memoryUpdate(db, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: error.message }],
        isError: true,
      };
    }
  }
);

// memory_forget - Remove a memory
server.tool(
  'memory_forget',
  'Remove a memory and all its associated data (tags, relationships, embeddings)',
  {
    id: z.string().describe('Memory ID to remove'),
  },
  async (params) => {
    try {
      const db = getConnection(projectPath);
      const result = memoryForget(db, params.id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: error.message }],
        isError: true,
      };
    }
  }
);

// memory_init - Auto-scan codebase and build initial memories
server.tool(
  'memory_init',
  'Scan a project codebase and build initial memories from CLAUDE.md, MEMORY.md, git history, and schema files',
  {
    project_path: z.string().optional().describe('Path to project root (defaults to KODA_PROJECT_PATH)'),
  },
  async (params) => {
    const targetPath = params.project_path || projectPath;
    const db = getConnection(targetPath);
    const result = await memoryInit(db, targetPath);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// session_start - Begin a new work session
server.tool(
  'session_start',
  'Start a new work session, returns recent sessions and important memories',
  {
    project: z.string().optional().describe('Project name (defaults to folder name)'),
  },
  async (params) => {
    const db = getConnection(projectPath);
    const project = params.project || projectPath.split(/[\\/]/).pop() || 'unknown';
    const result = sessionStart(db, project);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// session_end - End the current work session
server.tool(
  'session_end',
  'End a work session with a summary of what was done',
  {
    session_id: z.string().describe('Session ID from session_start'),
    summary: z.string().describe('What was accomplished'),
    branch: z.string().optional().describe('Git branch worked on'),
    commit_count: z.number().optional().describe('Number of commits made'),
  },
  async (params) => {
    try {
      const db = getConnection(projectPath);
      const result = sessionEnd(db, params.session_id, params.summary, params.branch, params.commit_count);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: error.message }],
        isError: true,
      };
    }
  }
);

// session_list - Show recent work sessions
server.tool(
  'session_list',
  'List recent work sessions for a project',
  {
    project: z.string().optional().describe('Project name (defaults to folder name)'),
    limit: z.number().optional().describe('Max sessions to return (default 10)'),
  },
  async (params) => {
    const db = getConnection(projectPath);
    const project = params.project || projectPath.split(/[\\/]/).pop() || 'unknown';
    const result = sessionList(db, project, params.limit);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// project_health - Check project and memory state
server.tool(
  'project_health',
  'Check project health: git status, memory stats, environment, stale memories',
  {
    project_path: z.string().optional().describe('Path to project root (defaults to KODA_PROJECT_PATH)'),
    auto_archive: z.boolean().optional().describe('Archive memories not accessed in 60+ days (default false)'),
  },
  async (params) => {
    const targetPath = params.project_path || projectPath;
    const db = getConnection(targetPath);
    const report = projectHealth(db, targetPath);

    if (params.auto_archive) {
      const archived = archiveStaleMemories(db);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ...report, archived: archived.archived }, null, 2),
          },
        ],
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
    };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Failed to start Koda Memory server:', error);
  process.exit(1);
});

// Clean shutdown
process.on('SIGINT', () => {
  closeAllConnections();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeAllConnections();
  process.exit(0);
});
