import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { getConnection, closeConnection } from './db/connection.js';
import { memoryStore } from './tools/memory-store.js';
import { memoryRecall } from './tools/memory-recall.js';
import { memorySearch } from './tools/memory-search.js';
import { memoryRelate } from './tools/memory-relate.js';
import { memoryContext } from './tools/memory-context.js';
import { memoryUpdate } from './tools/memory-update.js';
import { memoryForget } from './tools/memory-forget.js';
import { sessionStart, sessionEnd, sessionList } from './tools/session.js';
import { projectHealth, archiveStaleMemories } from './tools/health.js';

// --- Config ---

const PORT = parseInt(process.env.PORT || '3848', 10);
const KODA_API_KEY = process.env.KODA_API_KEY;

function resolveProject(paramProject?: string): string {
  return paramProject || process.env.KODA_DEFAULT_PROJECT || 'default';
}

// --- Auth ---

function authenticate(req: IncomingMessage): boolean {
  if (!KODA_API_KEY) return true; // No key = no auth (dev mode)
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const [scheme, token] = auth.split(' ');
  return scheme === 'Bearer' && token === KODA_API_KEY;
}

// --- MCP Server factory ---

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'koda-memory',
    version: '0.1.0',
  });

  // memory_store
  server.tool(
    'memory_store',
    'Save a new memory (decision, lesson, rule, preference, or fact)',
    {
      content: z.string().describe('The memory content'),
      category: z.enum(['decision', 'lesson', 'rule', 'preference', 'fact']).describe('Memory category'),
      why: z.string().optional().describe('Why this matters'),
      tags: z.array(z.string()).optional().describe('Tags for filtering'),
      source: z.enum(['user-stated', 'auto-captured', 'correction']).optional().describe('How this was captured'),
      project: z.string().optional().describe('Project name (defaults to KODA_DEFAULT_PROJECT)'),
    },
    async (params) => {
      const db = getConnection();
      const project = resolveProject(params.project);
      const result = await memoryStore(db, project, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // memory_recall
  server.tool(
    'memory_recall',
    'Retrieve a specific memory by its ID',
    {
      id: z.string().describe('Memory ID (e.g. mem_0001)'),
    },
    async (params) => {
      const db = getConnection();
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

  // memory_search
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
      const db = getConnection();
      const results = await memorySearch(db, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  // memory_context
  server.tool(
    'memory_context',
    'Get relevant memories for a task using blended keyword + semantic + graph search',
    {
      task_description: z.string().describe('What you are working on'),
      limit: z.number().optional().describe('Max results (default 15)'),
      graph_depth: z.number().min(1).max(3).optional().describe('Graph traversal depth (default 1, max 3)'),
    },
    async (params) => {
      const db = getConnection();
      const result = await memoryContext(db, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // memory_relate
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
        const db = getConnection();
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

  // memory_update
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
        const db = getConnection();
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

  // memory_forget
  server.tool(
    'memory_forget',
    'Remove a memory and all its associated data (tags, relationships, embeddings)',
    {
      id: z.string().describe('Memory ID to remove'),
    },
    async (params) => {
      try {
        const db = getConnection();
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

  // memory_init — not available in remote mode
  server.tool(
    'memory_init',
    'Scan a project codebase and build initial memories (requires local access)',
    {
      project_path: z.string().optional().describe('Path to project root'),
    },
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: 'memory_init is not available in remote mode. It requires local filesystem access to scan CLAUDE.md, git history, and schema files. Run koda-memory locally with stdio transport for initial project scans.',
        }],
        isError: true,
      };
    }
  );

  // session_start
  server.tool(
    'session_start',
    'Start a new work session, returns recent sessions and important memories',
    {
      project: z.string().optional().describe('Project name (defaults to KODA_DEFAULT_PROJECT)'),
    },
    async (params) => {
      const db = getConnection();
      const project = resolveProject(params.project);
      const result = sessionStart(db, project);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // session_end
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
        const db = getConnection();
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

  // session_list
  server.tool(
    'session_list',
    'List recent work sessions for a project',
    {
      project: z.string().optional().describe('Project name (defaults to KODA_DEFAULT_PROJECT)'),
      limit: z.number().optional().describe('Max sessions to return (default 10)'),
    },
    async (params) => {
      const db = getConnection();
      const project = resolveProject(params.project);
      const result = sessionList(db, project, params.limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // project_health
  server.tool(
    'project_health',
    'Check memory health: stats, stale memories, environment',
    {
      auto_archive: z.boolean().optional().describe('Archive memories not accessed in 60+ days (default false)'),
    },
    async (params) => {
      const db = getConnection();
      const report = projectHealth(db);

      if (params.auto_archive) {
        const archived = archiveStaleMemories(db);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ...report, archived: archived.archived }, null, 2),
          }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    }
  );

  return server;
}

// --- HTTP Server ---

// Streamable HTTP sessions
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();

// SSE sessions (legacy — used by Claude Code "type": "sse")
const sseTransports = new Map<string, SSEServerTransport>();

async function main() {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Health check — no auth required
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
      return;
    }

    // All other routes require auth
    if (!authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // === SSE Transport (legacy) ===
    // GET /sse — establish SSE stream
    if (url.pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      const mcpServer = createMcpServer();

      transport.onclose = () => {
        sseTransports.delete(transport.sessionId);
      };

      await mcpServer.connect(transport);
      sseTransports.set(transport.sessionId, transport);
      return;
    }

    // POST /messages — SSE message endpoint
    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !sseTransports.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
        return;
      }

      const transport = sseTransports.get(sessionId)!;
      await transport.handlePostMessage(req, res);
      return;
    }

    // === Streamable HTTP Transport (modern) ===
    if (url.pathname === '/mcp') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (sessionId && streamableTransports.has(sessionId)) {
          const transport = streamableTransports.get(sessionId)!;
          await transport.handleRequest(req, res);
        } else if (req.method === 'GET') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid session ID' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
        }
        return;
      }

      if (req.method === 'POST') {
        if (sessionId && streamableTransports.has(sessionId)) {
          const transport = streamableTransports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            streamableTransports.delete(transport.sessionId);
          }
        };

        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);

        if (transport.sessionId) {
          streamableTransports.set(transport.sessionId, transport);
        }
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Koda Memory server listening on http://0.0.0.0:${PORT}`);
    console.log(`SSE endpoint: GET /sse + POST /messages`);
    console.log(`Streamable HTTP endpoint: POST /mcp`);
    console.log(`Auth: ${KODA_API_KEY ? 'enabled' : 'DISABLED (no KODA_API_KEY set)'}`);
    console.log(`DB: ${process.env.KODA_DB_PATH || '(default: .koda/brain.db)'}`);
  });
}

main().catch((error) => {
  console.error('Failed to start Koda Memory server:', error);
  process.exit(1);
});

// Clean shutdown
process.on('SIGINT', () => {
  closeConnection();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeConnection();
  process.exit(0);
});
