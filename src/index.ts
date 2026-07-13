import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
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
import { memoryFlag } from './tools/memory-flag.js';
import { sessionStart, sessionEnd, sessionList } from './tools/session.js';
import { projectHealth, archiveStaleMemories } from './tools/health.js';
import { recordAudit } from './tools/audit.js';
import { buildUserMap, resolveUserFromToken, extractToken } from './auth.js';
import { runValidationBatch, startValidationScheduler } from './validation/engine.js';
import { normalizeProject } from './project-alias.js';

// --- Config ---

const PORT = parseInt(process.env.PORT || '3848', 10);

function resolveProject(paramProject?: string): string {
  return normalizeProject(paramProject || process.env.KODA_DEFAULT_PROJECT || 'default');
}

// Per-user API key resolution lives in ./auth.js (extracted for unit testing).
const USER_MAP = buildUserMap();

// --- MCP Server factory ---

function createMcpServer(userId: string): McpServer {
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
      scope: z.enum(['personal', 'project']).optional().describe(
        'personal (default) = only you can see it; project = visible to all Sifututor team members'
      ),
    },
    async (params) => {
      const db = getConnection();
      const project = resolveProject(params.project);
      const effectiveUserId = params.scope === 'project' ? 'sifututor' : userId;
      const result = await memoryStore(db, project, effectiveUserId, params, userId);
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
      const memory = memoryRecall(db, userId, params.id);
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
    'Search memories using keyword search with optional category, tag, and project filters',
    {
      query: z.string().describe('Search query (supports phrases and prefix matching)'),
      category: z.enum(['decision', 'lesson', 'rule', 'preference', 'fact']).optional().describe('Filter by category'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      project: z.string().optional().describe('Filter to a single project (e.g. "sifu-tutor", "ripple-suite")'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async (params) => {
      const db = getConnection();
      const results = await memorySearch(db, userId, params);
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
      project: z.string().optional().describe('Filter to a single project (e.g. "sifu-tutor", "ripple-suite")'),
      limit: z.number().optional().describe('Max results (default 15)'),
      graph_depth: z.number().min(1).max(3).optional().describe('Graph traversal depth (default 1, max 3)'),
    },
    async (params) => {
      const db = getConnection();
      const result = await memoryContext(db, userId, params);
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
        const result = memoryRelate(db, userId, params);
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
        const result = await memoryUpdate(db, userId, params);
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
        const result = memoryForget(db, userId, params.id);
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

  // memory_flag
  server.tool(
    'memory_flag',
    'Flag a shared/project memory as potentially outdated for human review (or clear a flag). Does not delete or change confidence. Any team member can flag any memory they can see.',
    {
      id: z.string().describe('Memory ID to flag'),
      reason: z.string().optional().describe('Why it looks outdated'),
      clear: z.boolean().optional().describe('Set true to remove an existing flag'),
    },
    async (params) => {
      try {
        const db = getConnection();
        const result = memoryFlag(db, userId, params);
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
      const result = sessionStart(db, project, userId);
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
        const result = sessionEnd(db, userId, params.session_id, params.summary, params.branch, params.commit_count);
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
      const result = sessionList(db, project, params.limit, userId);
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
      project: z.string().optional().describe('Scope stats to a single project (e.g. "sifu-tutor"); omit for everything you can see'),
      auto_archive: z.boolean().optional().describe('Archive memories not accessed in 60+ days (default false)'),
    },
    async (params) => {
      const db = getConnection();
      const project = params.project ? normalizeProject(params.project) : undefined;
      const report = projectHealth(db, userId, project);

      if (params.auto_archive) {
        const archived = archiveStaleMemories(db, userId, project);
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

  // validation_run
  server.tool(
    'validation_run',
    'Run the background validation pipeline (duplicate + contradiction detection). Returns batch results.',
    {
      batch_size: z.number().optional().describe('Number of jobs to process in this batch (default 10)'),
    },
    async (params) => {
      const db = getConnection();
      const result = await runValidationBatch(db, userId, params.batch_size);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}

// --- Admin REST helpers ---

interface AdminPath {
  route: string;
  id?: string;
  action?: string;
}

function parseAdminPath(pathname: string): AdminPath | null {
  if (!pathname.startsWith('/admin/') && pathname !== '/admin') return null;

  const rest = pathname.replace(/^\/admin\/?/, '');
  if (!rest) return null;

  if (rest === 'stats') return { route: 'stats' };
  if (rest === 'graph') return { route: 'graph' };
  if (rest === 'validation/queue') return { route: 'validation-queue' };
  if (rest === 'audit') return { route: 'audit' };
  if (rest === 'search-gaps') return { route: 'search-gaps' };
  if (rest === 'memories') return { route: 'memories' };

  const memMatch = rest.match(/^memories\/([^/]+)(?:\/([^/]+))?$/);
  if (memMatch) {
    const [, id, action] = memMatch;
    if (action) return { route: 'memory-action', id, action };
    return { route: 'memory', id };
  }

  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonOk(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function jsonErr(res: ServerResponse, message: string, status = 500): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// --- HTTP server factory (exported for testing) ---

/**
 * Create the Koda HTTP server.
 *
 * opts.userMap  — token→userId map; defaults to USER_MAP (built from env vars)
 * opts.dbGetter — function that returns the DB connection; defaults to getConnection()
 *
 * The returned server is NOT yet listening. Call server.listen(port, ...) to start it.
 * This separation enables unit tests to start the server on an ephemeral port (listen(0))
 * with a temp DB and a known API key, without touching the real database.
 */
export function createHttpServer(opts?: {
  userMap?: Map<string, string>;
  dbGetter?: () => Database.Database;
}): Server {
  const userMap = opts?.userMap ?? USER_MAP;
  const dbGetter = opts?.dbGetter ?? getConnection;

  // Per-server session state — each createHttpServer() call gets its own maps
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  const sseTransports = new Map<string, SSEServerTransport>();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Health check — no auth required
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
      return;
    }

    // Dashboard static files — no auth required (browser needs HTML/JS to render the login page)
    if (url.pathname.startsWith('/dashboard') && req.method === 'GET') {
      const dashboardDist = path.join(process.cwd(), 'dashboard', 'dist');
      let filePath = url.pathname.replace('/dashboard', '') || '/index.html';
      if (filePath === '/') filePath = '/index.html';
      const fullPath = path.join(dashboardDist, filePath);
      try {
        const content = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const mimes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
        };
        res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
        res.end(content);
      } catch {
        // asset not found — serve index.html for SPA routing
        try {
          const index = fs.readFileSync(path.join(dashboardDist, 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(index);
        } catch {
          res.writeHead(404);
          res.end('Not Found');
        }
      }
      return;
    }

    // All other routes require auth
    const authToken = extractToken(req.headers['authorization'], req.url, req.headers.host);
    const userId = resolveUserFromToken(userMap, authToken);
    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // === SSE Transport (legacy) ===
    if (url.pathname === '/sse' && req.method === 'GET') {
      const messagesPath = process.env.KODA_BASE_PATH ? `${process.env.KODA_BASE_PATH}/messages` : '/messages';
      const transport = new SSEServerTransport(messagesPath, res);
      const mcpServer = createMcpServer(userId);

      transport.onclose = () => {
        sseTransports.delete(transport.sessionId);
      };

      await mcpServer.connect(transport);
      sseTransports.set(transport.sessionId, transport);
      return;
    }

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

        const mcpServer = createMcpServer(userId);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);

        if (transport.sessionId) {
          streamableTransports.set(transport.sessionId, transport);
        }
        return;
      }
    }

    // === Admin REST API ===
    if (url.pathname.startsWith('/admin/') || url.pathname === '/admin') {
      const adminPath = parseAdminPath(url.pathname);
      if (!adminPath) {
        jsonErr(res, 'Not Found', 404);
        return;
      }

      try {
        const db = dbGetter();

        // GET /admin/stats
        if (adminPath.route === 'stats' && req.method === 'GET') {
          const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number };

          const byUserRows = db.prepare(
            'SELECT user_id, COUNT(*) as cnt FROM memories GROUP BY user_id'
          ).all() as { user_id: string; cnt: number }[];
          const by_user: Record<string, number> = {};
          for (const r of byUserRows) by_user[r.user_id] = r.cnt;

          const byProjectRows = db.prepare(
            'SELECT project, COUNT(*) as cnt FROM memories GROUP BY project'
          ).all() as { project: string; cnt: number }[];
          const by_project: Record<string, number> = {};
          for (const r of byProjectRows) by_project[r.project] = r.cnt;

          const byConfRows = db.prepare(
            'SELECT confidence, COUNT(*) as cnt FROM memories GROUP BY confidence'
          ).all() as { confidence: string; cnt: number }[];
          const by_confidence: Record<string, number> = {};
          for (const r of byConfRows) by_confidence[r.confidence] = r.cnt;

          const byCatRows = db.prepare(
            'SELECT category, COUNT(*) as cnt FROM memories GROUP BY category'
          ).all() as { category: string; cnt: number }[];
          const by_category: Record<string, number> = {};
          for (const r of byCatRows) by_category[r.category] = r.cnt;

          const flaggedRow = db.prepare(
            'SELECT COUNT(*) as cnt FROM memories WHERE flagged_outdated_by IS NOT NULL'
          ).get() as { cnt: number };

          const supersededRow = db.prepare(
            'SELECT COUNT(*) as cnt FROM memories WHERE superseded_at IS NOT NULL'
          ).get() as { cnt: number };

          const deletedRow = db.prepare(
            'SELECT COUNT(*) as cnt FROM memories WHERE deleted_at IS NOT NULL'
          ).get() as { cnt: number };

          const queueDepthRow = db.prepare(
            "SELECT COUNT(*) as cnt FROM validation_queue WHERE status = 'pending'"
          ).get() as { cnt: number };

          const searchGapsRow = db.prepare(
            'SELECT COUNT(*) as cnt FROM search_gaps'
          ).get() as { cnt: number };

          const auditCountRow = db.prepare(
            'SELECT COUNT(*) as cnt FROM audit_log'
          ).get() as { cnt: number };

          jsonOk(res, {
            total_memories: totalRow.cnt,
            by_user,
            by_project,
            by_confidence,
            by_category,
            flagged_count: flaggedRow.cnt,
            superseded_count: supersededRow.cnt,
            deleted_count: deletedRow.cnt,
            validation_queue_depth: queueDepthRow.cnt,
            search_gaps_count: searchGapsRow.cnt,
            recent_audit_count: auditCountRow.cnt,
          });
          return;
        }

        // GET /admin/memories (paginated list)
        if (adminPath.route === 'memories' && req.method === 'GET') {
          const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
          const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
          const offset = (page - 1) * limit;

          const filters: string[] = [];
          const params: unknown[] = [];

          const projectFilter = url.searchParams.get('project');
          if (projectFilter) { filters.push('m.project = ?'); params.push(projectFilter); }

          const userFilter = url.searchParams.get('user');
          if (userFilter) { filters.push('m.user_id = ?'); params.push(userFilter); }

          const confidenceFilter = url.searchParams.get('confidence');
          if (confidenceFilter) { filters.push('m.confidence = ?'); params.push(confidenceFilter); }

          const categoryFilter = url.searchParams.get('category');
          if (categoryFilter) { filters.push('m.category = ?'); params.push(categoryFilter); }

          const qFilter = url.searchParams.get('q');
          if (qFilter) { filters.push('m.content LIKE ?'); params.push(`%${qFilter}%`); }

          const flaggedFilter = url.searchParams.get('flagged');
          if (flaggedFilter === 'true') { filters.push('m.flagged_outdated_by IS NOT NULL'); }
          else if (flaggedFilter === 'false') { filters.push('m.flagged_outdated_by IS NULL'); }

          const supersededFilter = url.searchParams.get('superseded');
          if (supersededFilter === 'true') { filters.push('m.superseded_at IS NOT NULL'); }
          else { filters.push('m.superseded_at IS NULL'); }

          const deletedFilter = url.searchParams.get('deleted');
          if (deletedFilter === 'true') { filters.push('m.deleted_at IS NOT NULL'); }
          else { filters.push('m.deleted_at IS NULL'); }

          const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

          const countRow = db.prepare(
            `SELECT COUNT(*) as cnt FROM memories m ${where}`
          ).get(...params) as { cnt: number };
          const total = countRow.cnt;

          const memories = db.prepare(`
            SELECT m.id, m.project, m.user_id, m.category,
                   SUBSTR(m.content, 1, 200) as content,
                   m.confidence, m.created_at, m.updated_at, m.access_count,
                   m.flagged_outdated_by, m.superseded_at, m.deleted_at
            FROM memories m
            ${where}
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
          `).all(...params, limit, offset) as Record<string, unknown>[];

          const withTags = memories.map((mem) => {
            const tags = (db.prepare(
              'SELECT tag FROM tags WHERE memory_id = ? ORDER BY tag'
            ).all(mem.id) as { tag: string }[]).map((t) => t.tag);
            return { ...mem, tags };
          });

          jsonOk(res, {
            memories: withTags,
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
          });
          return;
        }

        // GET /admin/memories/:id
        if (adminPath.route === 'memory' && req.method === 'GET' && adminPath.id) {
          const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get(adminPath.id);
          if (!mem) { jsonErr(res, 'Memory not found', 404); return; }

          const tags = (db.prepare(
            'SELECT tag FROM tags WHERE memory_id = ? ORDER BY tag'
          ).all(adminPath.id) as { tag: string }[]).map((t) => t.tag);

          const relationships = db.prepare(`
            SELECT source_id, target_id, relation_type, created_at
            FROM relationships
            WHERE source_id = ? OR target_id = ?
            ORDER BY created_at DESC
          `).all(adminPath.id, adminPath.id);

          jsonOk(res, { memory: mem, tags, relationships });
          return;
        }

        // POST /admin/memories/:id/restore
        if (adminPath.route === 'memory-action' && adminPath.action === 'restore' && req.method === 'POST') {
          const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(adminPath.id);
          if (!existing) { jsonErr(res, 'Memory not found', 404); return; }

          db.prepare(
            'UPDATE memories SET deleted_at = NULL, updated_at = ? WHERE id = ?'
          ).run(new Date().toISOString(), adminPath.id);

          recordAudit(db, adminPath.id!, 'restore', userId, { via: 'admin' });

          jsonOk(res, { ok: true, id: adminPath.id });
          return;
        }

        // DELETE /admin/memories/:id (soft delete)
        if (adminPath.route === 'memory' && req.method === 'DELETE' && adminPath.id) {
          const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(adminPath.id);
          if (!existing) { jsonErr(res, 'Memory not found', 404); return; }

          db.prepare(
            'UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?'
          ).run(new Date().toISOString(), new Date().toISOString(), adminPath.id);

          recordAudit(db, adminPath.id!, 'delete', userId, { via: 'admin' });

          jsonOk(res, { ok: true, id: adminPath.id });
          return;
        }

        // GET /admin/graph
        //   ?project=     filter to a project
        //   ?focus=<id>   center on one memory + neighbours within ?depth (default 1, max 3)
        //   ?mode=connected (default) only nodes with a relationship; mode=all includes isolated nodes
        //   ?limit=       node cap (default 200, max 1000)
        if (adminPath.route === 'graph' && req.method === 'GET') {
          const graphLimit = Math.min(1000, parseInt(url.searchParams.get('limit') || '200', 10));
          const graphProject = url.searchParams.get('project');
          const focusId = url.searchParams.get('focus');
          const depth = Math.min(3, Math.max(1, parseInt(url.searchParams.get('depth') || '1', 10)));
          const mode = url.searchParams.get('mode') || 'connected';

          const allLinks = db.prepare(`
            SELECT source_id, target_id, relation_type as type FROM relationships
          `).all() as { source_id: string; target_id: string; type: string }[];

          const nodeSelect = `
            SELECT m.id, SUBSTR(m.content, 1, 60) as label, m.confidence, m.user_id, m.category,
                   m.project, m.access_count, m.content
            FROM memories m
          `;
          const baseFilters = ['m.deleted_at IS NULL', 'm.superseded_at IS NULL'];
          const baseParams: unknown[] = [];
          if (graphProject) { baseFilters.push('m.project = ?'); baseParams.push(graphProject); }

          type NodeRow = { id: string; label: string; confidence: string; user_id: string; category: string; project: string; access_count: number; content: string };
          let nodes: NodeRow[];

          if (focusId) {
            // BFS out from the focus node across relationships, up to `depth` hops.
            const adjacency = new Map<string, Set<string>>();
            for (const l of allLinks) {
              if (!adjacency.has(l.source_id)) adjacency.set(l.source_id, new Set());
              if (!adjacency.has(l.target_id)) adjacency.set(l.target_id, new Set());
              adjacency.get(l.source_id)!.add(l.target_id);
              adjacency.get(l.target_id)!.add(l.source_id);
            }
            const keep = new Set<string>([focusId]);
            let frontier = [focusId];
            for (let d = 0; d < depth; d++) {
              const next: string[] = [];
              for (const id of frontier) {
                for (const nb of adjacency.get(id) ?? []) {
                  if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
                }
              }
              frontier = next;
            }
            const ids = [...keep];
            const placeholders = ids.map(() => '?').join(',');
            nodes = db.prepare(
              `${nodeSelect} WHERE ${baseFilters.join(' AND ')} AND m.id IN (${placeholders}) LIMIT ?`
            ).all(...baseParams, ...ids, graphLimit) as NodeRow[];
          } else if (mode === 'connected') {
            // Only nodes that participate in at least one relationship — keeps the
            // graph meaningful instead of showing hundreds of isolated dots.
            const connectedIds = new Set<string>();
            for (const l of allLinks) { connectedIds.add(l.source_id); connectedIds.add(l.target_id); }
            if (connectedIds.size === 0) {
              nodes = [];
            } else {
              const ids = [...connectedIds];
              const placeholders = ids.map(() => '?').join(',');
              nodes = db.prepare(
                `${nodeSelect} WHERE ${baseFilters.join(' AND ')} AND m.id IN (${placeholders})
                 ORDER BY m.access_count DESC LIMIT ?`
              ).all(...baseParams, ...ids, graphLimit) as NodeRow[];
            }
          } else {
            // mode=all — every visible node, capped.
            nodes = db.prepare(
              `${nodeSelect} WHERE ${baseFilters.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`
            ).all(...baseParams, graphLimit) as NodeRow[];
          }

          const nodeIds = new Set(nodes.map((n) => n.id));
          const links = allLinks
            .filter((l) => nodeIds.has(l.source_id) && nodeIds.has(l.target_id))
            .map((l) => ({ source: l.source_id, target: l.target_id, type: l.type }));

          jsonOk(res, { nodes, links, mode: focusId ? 'focus' : mode, focus: focusId || null });
          return;
        }

        // GET /admin/validation/queue
        if (adminPath.route === 'validation-queue' && req.method === 'GET') {
          const statusFilter = url.searchParams.get('status') || 'pending';
          const jobs = db.prepare(`
            SELECT id, memory_id, job_type, status, attempts, last_error, created_at, processed_at
            FROM validation_queue
            WHERE status = ?
            ORDER BY created_at ASC
          `).all(statusFilter);
          const totalRow = db.prepare(
            'SELECT COUNT(*) as cnt FROM validation_queue WHERE status = ?'
          ).get(statusFilter) as { cnt: number };
          jsonOk(res, { jobs, total: totalRow.cnt });
          return;
        }

        // GET /admin/audit
        if (adminPath.route === 'audit' && req.method === 'GET') {
          const auditLimit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10));
          const auditMemoryId = url.searchParams.get('memory_id');

          if (auditMemoryId) {
            const entries = db.prepare(`
              SELECT id, memory_id, action, actor, payload, created_at
              FROM audit_log
              WHERE memory_id = ?
              ORDER BY created_at DESC
              LIMIT ?
            `).all(auditMemoryId, auditLimit);
            jsonOk(res, { entries });
          } else {
            const entries = db.prepare(`
              SELECT id, memory_id, action, actor, payload, created_at
              FROM audit_log
              ORDER BY created_at DESC
              LIMIT ?
            `).all(auditLimit);
            jsonOk(res, { entries });
          }
          return;
        }

        // GET /admin/search-gaps
        if (adminPath.route === 'search-gaps' && req.method === 'GET') {
          const gapLimit = Math.min(200, parseInt(url.searchParams.get('limit') || '20', 10));
          const gapProject = url.searchParams.get('project');

          if (gapProject) {
            const gaps = db.prepare(`
              SELECT id, query, result_count, top_score, user_id, project, created_at
              FROM search_gaps
              WHERE project = ?
              ORDER BY created_at DESC
              LIMIT ?
            `).all(gapProject, gapLimit);
            jsonOk(res, { gaps });
          } else {
            const gaps = db.prepare(`
              SELECT id, query, result_count, top_score, user_id, project, created_at
              FROM search_gaps
              ORDER BY created_at DESC
              LIMIT ?
            `).all(gapLimit);
            jsonOk(res, { gaps });
          }
          return;
        }

        jsonErr(res, 'Not Found', 404);
        return;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        jsonErr(res, message, 500);
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  });
}

// --- Entry point ---

async function main() {
  const server = createHttpServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Koda Memory server listening on http://0.0.0.0:${PORT}`);
    console.log(`SSE endpoint: GET /sse + POST /messages`);
    console.log(`Streamable HTTP endpoint: POST /mcp`);
    console.log(`Auth: ${USER_MAP.size > 0 ? 'enabled' : 'DISABLED (no keys set — dev mode)'}`);
    console.log(`DB: ${process.env.KODA_DB_PATH || '(default: .koda/brain.db)'}`);
  });

  // Drain the validation queue automatically in the background.
  startValidationScheduler(getConnection());
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
