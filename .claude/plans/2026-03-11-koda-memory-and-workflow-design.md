# Koda Memory Server + Workflow Improvements Design

**Date:** 2026-03-11
**Status:** Approved
**Problem:** Claude Code loses context between sessions, MEMORY.md is bloated and wastes tokens, and parallel Claude instances can't share knowledge. Additionally, Ripple's workflow lacks git worktree isolation and automatic code review.

## Part 1: Koda Memory MCP Server

### What We're Building

A custom MCP server that gives Claude Code a smart, searchable memory database instead of flat Markdown files. Claude calls tools like `memory_store`, `memory_search`, and `memory_context` to interact with a local SQLite database that uses keyword search, vector search, and relationship graphs to return only relevant memories per task.

### Why This Matters (Non-Technical)

Right now, Claude reads a 200-line MEMORY.md file every single message, even when 90% of it is irrelevant. It's like reading an entire encyclopedia before answering one question. The memory server lets Claude ask specific questions ("what do I know about payment slips?") and get back only the relevant answers. This saves tokens (money), reduces confusion, and lets Claude remember things across sessions properly.

### Design Decisions (from brainstorming Q&A)

| Question | Decision | Rationale |
|----------|----------|-----------|
| Scope | Any project (not Ripple-specific) | One server works for Ripple, Koda, future projects. Project-specific knowledge is stored as tagged entries. |
| Location | New standalone project (`~/Projects/koda-memory/`) | Clean separation. Can be published to npm later. |
| Search capability | Full: keyword + vector + graph | All-in-one from day one. No phased rollout. |
| Hosting | Local only | Database file lives inside each project folder. Cloud sync can be added later. |
| Embedding API | OpenAI text-embedding-3-small | Already have API key. Costs ~$0.01 per 10K memories. |
| Initial data | Auto-scan codebase on first use | Reads CLAUDE.md, MEMORY.md, docs, git log. No manual import. |

### Data Model

#### Database: `<project-root>/.koda/brain.db` (SQLite)

**memories** - Core memory storage
```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,           -- mem_001, mem_002, ...
  project TEXT NOT NULL,         -- "ripple-suite", "koda"
  category TEXT NOT NULL,        -- decision | lesson | rule | preference | fact
  content TEXT NOT NULL,         -- The actual memory
  why TEXT,                      -- Why this matters (the intent layer)
  source TEXT DEFAULT 'auto',    -- user-stated | auto-captured | correction
  confidence TEXT DEFAULT 'inferred', -- confirmed | inferred | outdated
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_accessed TEXT,
  access_count INTEGER DEFAULT 0
);
```

**memories_fts** - Full-text search (FTS5)
```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, why, tags,
  content=memories,
  tokenize='porter unicode61'
);
```

**memory_embeddings** - Vector search (sqlite-vec)
```sql
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[1536]          -- text-embedding-3-small dimensions
);
```

**tags** - Labels for filtering
```sql
CREATE TABLE tags (
  memory_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES memories(id)
);
```

**relationships** - Graph connections
```sql
CREATE TABLE relationships (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,   -- relates-to | supersedes | contradicts | depends-on
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type),
  FOREIGN KEY (source_id) REFERENCES memories(id),
  FOREIGN KEY (target_id) REFERENCES memories(id)
);
```

**sessions** - Session tracking
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,                  -- What was worked on
  branch TEXT,
  commit_count INTEGER DEFAULT 0
);
```

### MCP Tools

#### Core Memory Tools

| Tool | Parameters | Returns | Purpose |
|------|-----------|---------|---------|
| `memory_store` | content, category, why?, tags[], source? | memory ID | Save a new memory |
| `memory_search` | query, category?, tags?, limit? | Ranked memory list | Keyword + vector + graph search |
| `memory_recall` | id | Full memory entry | Get a specific memory |
| `memory_update` | id, content?, why?, tags?, confidence? | Updated memory | Modify an existing memory |
| `memory_forget` | id | Confirmation | Remove a memory |
| `memory_relate` | source_id, target_id, relation_type | Relationship | Create a connection between memories |
| `memory_context` | task_description, limit? | Top N relevant memories | Smart multi-search for task context |

#### Setup Tools

| Tool | Parameters | Returns | Purpose |
|------|-----------|---------|---------|
| `memory_init` | project_path | Summary of what was learned | Auto-scan codebase and build initial memories |

#### Session Tools

| Tool | Parameters | Returns | Purpose |
|------|-----------|---------|---------|
| `session_start` | project | State summary + recent memories | Called when starting work |
| `session_end` | summary | Confirmation | Save session summary |
| `session_list` | project, limit? | Recent sessions | Show work history |

#### Health Tools

| Tool | Parameters | Returns | Purpose |
|------|-----------|---------|---------|
| `project_health` | project_path | Git status, pending migrations, env health | Check project state |

### How `memory_context` Works (The Smart Search)

When Claude calls `memory_context("Add a payment stat card to the dashboard")`:

1. **Keyword search (FTS5)**: Searches for "payment", "stat", "card", "dashboard" using BM25 ranking
2. **Vector search (sqlite-vec)**: Embeds the task description, finds semantically similar memories
3. **Graph traversal**: From matched memories, follow `relates-to` edges 1 level deep
4. **Blend scores**: FTS5 score (40%) + vector similarity (40%) + graph connectedness (20%)
5. **Return top 10-15**: Ranked by blended score, deduplicated

### Edge Case Handling

| Risk | Handling |
|------|---------|
| Database corruption | WAL mode for crash safety. Worst case: delete brain.db, re-run memory_init |
| Too many memories | Auto-archive memories not accessed in 60+ days |
| OpenAI API down | FTS5 + graph still work. Queue embeddings for later |
| Concurrent writes | SQLite WAL + write queue (one at a time) |
| Memory contradictions | Flag conflicts, surface to user on next search |
| Embedding costs | ~$0.01 per 10K memories. Negligible. |

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + TypeScript |
| Database | better-sqlite3 |
| Keyword search | FTS5 (SQLite built-in) |
| Vector search | sqlite-vec extension |
| Embeddings | OpenAI text-embedding-3-small |
| MCP framework | @modelcontextprotocol/sdk |
| Package manager | npm |

### Project Structure

```
koda-memory/
├── src/
│   ├── index.ts                 # MCP server entry point
│   ├── tools/                   # Tool implementations
│   │   ├── memory-store.ts
│   │   ├── memory-search.ts
│   │   ├── memory-context.ts
│   │   ├── memory-init.ts
│   │   ├── session.ts
│   │   └── health.ts
│   ├── db/
│   │   ├── schema.sql           # Table definitions
│   │   ├── connection.ts        # SQLite setup + extensions
│   │   └── migrations/          # Schema versioning
│   ├── search/
│   │   ├── fts.ts               # FTS5 keyword search
│   │   ├── vector.ts            # sqlite-vec similarity search
│   │   ├── graph.ts             # Relationship traversal
│   │   └── blend.ts             # Score blending + ranking
│   ├── scanner/
│   │   ├── codebase.ts          # Initial project scan
│   │   ├── markdown.ts          # Parse CLAUDE.md, MEMORY.md
│   │   ├── git.ts               # Git history analysis
│   │   └── schema.ts            # Migration/schema parsing
│   └── embeddings/
│       └── openai.ts            # Embedding generation
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Configuration

Added to each project's `.mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["C:/Users/Hafiz Razali/Projects/koda-memory/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",
        "KODA_PROJECT_PATH": "${workspaceFolder}"
      }
    }
  }
}
```

---

## Part 2: Workflow Improvements (Adopted from Koda Project)

### 2A: Git Worktree Adoption

**What:** Use git worktrees when running multiple Claude Code instances in parallel, so each works on an isolated copy of the codebase.

**Why:** The user plans to run multiple Claude instances fixing different things simultaneously. Without worktrees, they'd all conflict on the same files.

**How it works:**
- Each parallel task gets its own worktree + branch
- Worktrees live in `.claude/worktrees/` (already supported by Claude Code)
- Main workspace stays clean for the user
- After task is done: merge the worktree branch back, clean up

**When to use:** Only when running parallel tasks. Solo work continues on the feature branch as normal.

### 2B: Auto Code Review After Every Prompt

**What:** Code review becomes automatic after each build prompt, not manually triggered.

**Why:** Currently the user has to remember to call `/review`. Koda's SDD bakes review into the loop so it never gets skipped.

**How:** Update CLAUDE.md workflow section to mandate review after every prompt. The `/review` skill already exists - it just needs to be called consistently.

### 2C: SDD for Large Features (10+ Prompts)

**What:** For features with 10+ build prompts, use Subagent-Driven Development - fresh subagent per prompt.

**Why:** Long sessions bloat context. A fresh subagent gets clean context and makes fewer mistakes.

**When:** Only for large features (10+ prompts). Smaller tasks continue in the main session.

### 2D: Testing Strategy

**What:** Adopt a practical testing approach for Ripple. Not strict TDD (write test first every time), but systematic testing after each feature.

**Why:** Ripple currently has 112 Playwright tests but testing is inconsistent. Some features have full coverage, others have none. When bugs happen, there's no safety net to catch regressions.

**Practical approach for Ripple:**

| When | What to Test | How |
|------|-------------|-----|
| After each build prompt | Run existing tests to check nothing broke | `npx playwright test --grep @smoke` |
| After completing a feature | Generate tests for the new feature | Use `/generate-tests` skill |
| Before pushing to staging | Run full test suite | `npm run qa` |
| After fixing a bug | Write a test for that specific bug | Prevents the same bug from returning |

**Not doing full TDD because:** Ripple is an internal tool with 5-10 users. Writing tests before code for every change would slow development significantly. The practical approach is: build the feature, then write tests for the critical paths.

**The memory server helps here too:** When a bug is fixed, `memory_store` records the lesson. Next time Claude works on that area, `memory_context` returns the lesson and the test, so the same bug never happens twice.

---

## Next Steps

1. Create the `koda-memory` project at `~/Projects/koda-memory/`
2. Build the MCP server (scaffold, database, tools, search, scanner)
3. Connect to Ripple Suite via `.mcp.json`
4. Run `memory_init` to scan Ripple's codebase
5. Test with real tasks
6. Update Ripple's CLAUDE.md and MEMORY.md with workflow changes (worktrees, auto-review, SDD)
