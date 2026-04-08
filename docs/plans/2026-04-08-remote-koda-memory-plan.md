# Remote Koda Memory — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert Koda Memory from a local stdio MCP server to a remote HTTP MCP server hosted on the staging VPS, accessible from any device.

**Architecture:** Replace StdioServerTransport with StreamableHTTPServerTransport behind a Node.js HTTP server. Add Bearer token auth. Centralize DB path via env var. Deploy to staging VPS with nginx reverse proxy and pm2.

**Tech Stack:** Node.js, @modelcontextprotocol/sdk (StreamableHTTPServerTransport), better-sqlite3, pm2, nginx

---

### Task 1: Update `src/db/connection.ts` — centralize DB path

**Files:**
- Modify: `src/db/connection.ts`

**Step 1: Change `getDbPath` and `openDatabase` to use `KODA_DB_PATH` env var**

Replace the project-path-based DB resolution with a single env-var-driven path:

```typescript
export function getDbPath(): string {
  return process.env.KODA_DB_PATH || path.join(process.cwd(), '.koda', 'brain.db');
}

export function openDatabase(): Database.Database {
  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Enable WAL mode for crash safety and better concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Run schema if tables don't exist
  initializeSchema(db);

  // Create vector table (must be done after extension is loaded)
  createVectorTable(db);

  return db;
}
```

**Step 2: Simplify `getConnection` singleton — remove projectPath param**

```typescript
let connection: Database.Database | null = null;

export function getConnection(): Database.Database {
  if (connection) {
    try {
      connection.prepare('SELECT 1').get();
      return connection;
    } catch {
      connection = null;
    }
  }

  connection = openDatabase();
  return connection;
}

export function closeConnection(): void {
  if (connection) {
    connection.close();
    connection = null;
  }
}
```

Remove `ConnectionOptions` interface, `closeAllConnections`, and the `Map<string, Database>` pattern since we only have one DB now.

**Step 3: Verify it compiles**

Run: `cd /c/Users/Hafiz\ Razali/Documents/Projects/koda-memory && npx tsc --noEmit`
Expected: Errors in files that call `getConnection(projectPath)` — that's expected, we fix them in Task 2.

---

### Task 2: Update all tools to use simplified `getConnection()`

**Files:**
- Modify: `src/index.ts` (remove `projectPath` variable, update all tool handlers)
- Modify: `src/tools/health.ts` (remove `projectPath` param from `projectHealth`)

Every tool handler currently does `const db = getConnection(projectPath)`. Change all to `const db = getConnection()`.

**Step 1: Update `src/index.ts` tool handlers**

For each tool handler, remove the `projectPath` reference from `getConnection()` calls. The `project` name for `memory_store`, `session_start`, `session_list`, and `session_end` should come from:
- The tool's `project` param if provided by the caller
- Fall back to `KODA_DEFAULT_PROJECT` env var
- Fall back to `'default'`

Add this helper at the top of `index.ts`:

```typescript
function resolveProject(paramProject?: string): string {
  return paramProject || process.env.KODA_DEFAULT_PROJECT || 'default';
}
```

Update `memory_store` handler:
```typescript
async (params) => {
  const db = getConnection();
  const project = resolveProject(params.project);
  const result = await memoryStore(db, project, params);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
```

Add `project: z.string().optional().describe('Project name')` to the schema of: `memory_store`, `session_start`, `session_list`, `memory_init`, `project_health`.

For tools that don't need a project (memory_recall, memory_search, memory_context, memory_relate, memory_update, memory_forget): just change `getConnection(projectPath)` to `getConnection()`.

**Step 2: Update `src/tools/health.ts`**

The `projectHealth` function uses `projectPath` for git status and DB path. On the remote server, git status is irrelevant. Change to:
- Remove git status section (server has no project working directory)
- Get DB path from `getDbPath()` instead of constructing it from projectPath

```typescript
import { getDbPath } from '../db/connection.js';

export function projectHealth(db: Database.Database): HealthReport {
  // ... remove git section entirely
  // ... use getDbPath() for db_size_kb
  const dbPath = getDbPath();
  report.environment.db_path = dbPath;
  try {
    const stats = fs.statSync(dbPath);
    report.environment.db_size_kb = Math.round(stats.size / 1024);
  } catch { }
  // ...
}
```

**Step 3: Update `memory_init` tool**

The `memory_init` tool scans a project codebase (CLAUDE.md, git history, etc). This won't work on the remote server since there's no local codebase. Two options:
- Keep the tool but document it only works locally
- Or just have it return a helpful message when no project_path is available

Simplest: make it return a message saying "memory_init requires local access to the project codebase. Use stdio mode for initial scans."

**Step 4: Verify it compiles**

Run: `cd /c/Users/Hafiz\ Razali/Documents/Projects/koda-memory && npx tsc --noEmit`
Expected: PASS (0 errors)

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: centralize DB path and remove projectPath from connection layer"
```

---

### Task 3: Replace stdio transport with HTTP + auth

**Files:**
- Modify: `src/index.ts`

This is the core change. Replace `StdioServerTransport` with `StreamableHTTPServerTransport` behind a Node.js `http.createServer`.

**Step 1: Rewrite the `main()` function and imports**

```typescript
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
```

Remove the `StdioServerTransport` import.

**Step 2: Add auth middleware function**

```typescript
const KODA_API_KEY = process.env.KODA_API_KEY;

function authenticate(req: IncomingMessage): boolean {
  if (!KODA_API_KEY) return true; // No key set = no auth (dev mode)
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const [scheme, token] = auth.split(' ');
  return scheme === 'Bearer' && token === KODA_API_KEY;
}
```

**Step 3: Create HTTP server with transport-per-session**

```typescript
const PORT = parseInt(process.env.PORT || '3848', 10);

// Track transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

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

    // Only handle /mcp path
    if (url.pathname !== '/mcp') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Handle session management
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'GET' || req.method === 'DELETE') {
      // GET = SSE stream, DELETE = close session
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else if (req.method === 'GET') {
        // New SSE connection without session — not valid for GET
        res.writeHead(400);
        res.end('Missing session ID');
      } else {
        res.writeHead(404);
        res.end('Session not found');
      }
      return;
    }

    if (req.method === 'POST') {
      // Check if this is an existing session
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session (initialization request)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Koda Memory server listening on port ${PORT}`);
    console.log(`Auth: ${KODA_API_KEY ? 'enabled' : 'DISABLED (no KODA_API_KEY set)'}`);
  });
}
```

**Step 4: Update shutdown handlers**

```typescript
process.on('SIGINT', () => {
  closeConnection();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeConnection();
  process.exit(0);
});
```

**Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 6: Test locally**

```bash
# Terminal 1: Start server
KODA_DB_PATH=.koda/brain.db PORT=3848 node dist/index.js

# Terminal 2: Health check
curl http://localhost:3848/health
# Expected: {"status":"ok","version":"0.1.0"}

# Terminal 2: Auth rejection
curl -X POST http://localhost:3848/mcp -H "Content-Type: application/json" -d '{}'
# Expected: 200 or valid MCP response (no auth key set = open)

# With auth:
KODA_API_KEY=test123 KODA_DB_PATH=.koda/brain.db PORT=3848 node dist/index.js
curl http://localhost:3848/mcp
# Expected: 401 Unauthorized
```

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace stdio with HTTP transport and Bearer auth"
```

---

### Task 4: Build and test end-to-end locally

**Files:**
- None new — verification only

**Step 1: Build**

```bash
cd /c/Users/Hafiz\ Razali/Documents/Projects/koda-memory
npm run build
```

**Step 2: Run server locally with test DB**

```bash
KODA_DB_PATH=.koda/brain.db PORT=3848 node dist/index.js
```

**Step 3: Test with Claude Code**

Temporarily add to sifu-tutor `.claude/settings.json`:
```json
"memory": {
  "type": "sse",
  "url": "http://localhost:3848/mcp"
}
```

Open a new Claude Code session and verify `memory_search`, `session_start` tools are available and working.

**Step 4: Revert the temporary local config after testing**

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during local E2E testing"
```

---

### Task 5: Deploy to staging VPS

**Files:**
- Create: `ecosystem.config.cjs` (pm2 config)

**Step 1: Create pm2 config file**

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'koda-memory',
    script: 'dist/index.js',
    env: {
      PORT: 3848,
      KODA_DB_PATH: '/opt/koda/brain.db',
      KODA_API_KEY: process.env.KODA_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      NODE_ENV: 'production',
    },
    max_memory_restart: '256M',
    error_file: '/opt/koda/logs/error.log',
    out_file: '/opt/koda/logs/out.log',
    time: true,
  }],
};
```

**Step 2: Commit pm2 config**

```bash
git add ecosystem.config.cjs
git commit -m "chore: add pm2 ecosystem config for VPS deployment"
```

**Step 3: Push to GitHub**

```bash
git push origin main
```

**Step 4: SSH to VPS and set up**

```bash
ssh root@72.62.251.97

# Create directories
mkdir -p /opt/koda/backups /opt/koda/logs

# Clone repo
cd /opt
git clone https://github.com/hafizrazali90/koda-memory.git /opt/koda/app

# Install dependencies and build
cd /opt/koda/app
npm ci
npm run build

# Copy existing brain.db from local machine (do this from local terminal):
# scp .koda/brain.db root@72.62.251.97:/opt/koda/brain.db

# Set env vars and start with pm2
export KODA_API_KEY="<generate-a-strong-key>"
export OPENAI_API_KEY="<your-openai-key>"
cd /opt/koda/app
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # if not already done

# Verify
curl http://localhost:3848/health
```

**Step 5: Configure nginx**

Add to the existing nginx config for `sims-staging.tutorla.tech`:

```nginx
location /koda/ {
    proxy_pass http://127.0.0.1:3848/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}
```

```bash
nginx -t && systemctl reload nginx
```

**Step 6: Verify remote access**

```bash
# From local machine
curl https://sims-staging.tutorla.tech/koda/health
# Expected: {"status":"ok","version":"0.1.0"}

curl -X POST https://sims-staging.tutorla.tech/koda/mcp \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'
# Expected: MCP initialize response
```

---

### Task 6: Set up backup cron

**Step 1: SSH to VPS and add cron**

```bash
ssh root@72.62.251.97

# Add backup cron
crontab -e
# Add these lines:
# Daily backup at 3am
0 3 * * * cp /opt/koda/brain.db /opt/koda/backups/brain-$(date +\%Y\%m\%d).db 2>/dev/null
# Clean backups older than 30 days at 4am
0 4 * * * find /opt/koda/backups -name "brain-*.db" -mtime +30 -delete 2>/dev/null
```

**Step 2: Verify cron**

```bash
crontab -l | grep koda
# Expected: both cron lines visible
```

---

### Task 7: Update sifu-tutor MCP config

**Files:**
- Modify: `sifu-tutor/.claude/settings.json`

**Step 1: Add memory MCP server to mcpServers**

Add the `memory` entry alongside the existing `playwright` entry:

```json
"mcpServers": {
  "playwright": { ... },
  "memory": {
    "type": "sse",
    "url": "https://sims-staging.tutorla.tech/koda/mcp",
    "headers": {
      "Authorization": "Bearer <KODA_API_KEY>"
    }
  }
}
```

**Step 2: Verify in a new Claude Code session**

Open a new session in sifu-tutor. The `mcp__memory__*` tools should appear in the deferred tools list. Test:
- `memory_search` with a query
- `session_start` with `project: "sifu-tutor"`

**Step 3: Commit**

```bash
cd sifu-tutor
git add .claude/settings.json
git commit -m "chore: configure remote Koda Memory MCP server"
```

---

### Task 8: Migrate existing brain.db and clean up

**Step 1: Copy existing brain.db to VPS**

```bash
scp "c:/Users/Hafiz Razali/Documents/Projects/Sifututor/sifu-tutor/.koda/brain.db" root@72.62.251.97:/opt/koda/brain.db
```

**Step 2: Restart koda-memory on VPS to pick up the DB**

```bash
ssh root@72.62.251.97 "cd /opt/koda/app && pm2 restart koda-memory"
```

**Step 3: Verify data migrated**

```bash
curl -X POST https://sims-staging.tutorla.tech/koda/mcp \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"project_health","arguments":{}},"id":2}'
```

**Step 4: Remove local .koda/ from sifu-tutor**

Add `.koda/` to sifu-tutor's `.gitignore` if not already there. Delete the local `.koda/brain.db`.

**Step 5: Final commit**

```bash
git commit -m "chore: clean up local koda DB after migration to remote"
```
