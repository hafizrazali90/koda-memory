# Koda Memory MCP Server - Build Prompts

**Design doc:** `.claude/plans/2026-03-11-koda-memory-and-workflow-design.md`
**Project:** `C:/Users/Hafiz Razali/Documents/Projects/koda-memory/`
**Total prompts:** 10
**Estimated complexity:** Medium-High

---

## Prompt 1: Project Scaffold + Database Schema ⬜
**Complexity:** Low | **Dependencies:** None

### Non-Technical Explanation
Set up the project from scratch: create package.json, TypeScript config, install dependencies, and create the database tables. This is the foundation everything else builds on. Like laying the foundation and walls of a house before adding rooms.

### What to Build
1. Initialize npm project with TypeScript
2. Install dependencies:
   - `better-sqlite3` + `@types/better-sqlite3` (database)
   - `sqlite-vec` (vector search extension)
   - `@modelcontextprotocol/sdk` (MCP framework)
   - `openai` (embedding generation)
   - `vitest` (testing)
   - `tsx` (dev runner)
   - `typescript`, `@types/node`
3. Create `tsconfig.json` (target ES2022, module NodeNext)
4. Create `src/db/schema.sql` with all tables:
   - `memories` (core storage)
   - `memories_fts` (FTS5 virtual table)
   - `memory_embeddings` (sqlite-vec virtual table)
   - `tags` (labels)
   - `relationships` (graph edges)
   - `sessions` (session tracking)
5. Create `src/db/connection.ts`:
   - Opens/creates `brain.db` in project's `.koda/` folder
   - Enables WAL mode
   - Loads sqlite-vec extension
   - Runs schema if tables don't exist
6. Add npm scripts: `dev`, `build`, `test`

### Files to Create
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `src/db/schema.sql`
- `src/db/connection.ts`

### Verification
- `npm run build` compiles without errors
- Connection creates `.koda/brain.db` with all tables
- FTS5 and sqlite-vec extensions load successfully

---

## Prompt 2: MCP Server Entry Point + Basic Tools ⬜
**Complexity:** Medium | **Dependencies:** Prompt 1

### Non-Technical Explanation
Create the MCP server that Claude Code will talk to. Add the first two tools: `memory_store` (save a memory) and `memory_recall` (get a specific memory). This is like installing the front door of the house and adding a mailbox - Claude can now put things in and take things out.

### What to Build
1. Create `src/index.ts` - MCP server entry point:
   - Initialize MCP server with @modelcontextprotocol/sdk
   - Register tools
   - Handle stdio transport (how Claude Code communicates)
2. Create `src/tools/memory-store.ts`:
   - Accepts: content, category, why, tags[], source
   - Generates unique ID (mem_XXXX)
   - Inserts into `memories` table
   - Inserts into `memories_fts` (keyword index)
   - Inserts tags into `tags` table
   - Returns the memory ID
3. Create `src/tools/memory-recall.ts`:
   - Accepts: id
   - Returns full memory entry with tags
   - Updates `last_accessed` and `access_count`

### Files to Create
- `src/index.ts`
- `src/tools/memory-store.ts`
- `src/tools/memory-recall.ts`

### Verification
- Server starts without errors
- Can store a memory and recall it by ID
- FTS5 index is populated when storing

---

## Prompt 3: Keyword Search (FTS5) ⬜
**Complexity:** Medium | **Dependencies:** Prompt 2

### Non-Technical Explanation
Add the ability to search memories by keywords. If you stored "Never write to SIMS MySQL", searching for "SIMS" or "MySQL" or "write" would find it. Uses SQLite's built-in full-text search which is fast and ranks results by relevance.

### What to Build
1. Create `src/search/fts.ts`:
   - Full-text search using FTS5 BM25 ranking
   - Supports phrase queries ("exact phrase")
   - Supports prefix matching (pay* matches payment, payroll)
   - Returns scored results
2. Create `src/tools/memory-search.ts`:
   - Accepts: query, category?, tags?, limit?
   - Calls FTS5 search
   - Filters by category and tags if provided
   - Returns ranked results with scores

### Files to Create
- `src/search/fts.ts`
- `src/tools/memory-search.ts`

### Verification
- Store 5 memories on different topics
- Search finds relevant ones and ranks them
- Category/tag filters work correctly
- Partial word matches work (prefix search)

---

## Prompt 4: Vector Search (sqlite-vec + OpenAI Embeddings) ⬜
**Complexity:** High | **Dependencies:** Prompt 2

### Non-Technical Explanation
Add semantic search - finding memories by meaning, not just exact words. If you stored "Tutors must have bank details before payment", searching for "payment prerequisites" would find it even though those exact words aren't in the memory. Uses OpenAI to convert text into numbers (embeddings) that represent meaning, then sqlite-vec to find similar numbers.

### What to Build
1. Create `src/embeddings/openai.ts`:
   - Generate embeddings using text-embedding-3-small
   - Batch embedding support (multiple texts at once)
   - Error handling + retry on API failure
   - Queue system: if API is down, store text and embed later
2. Create `src/search/vector.ts`:
   - Insert embedding into `memory_embeddings` table
   - Cosine similarity search via sqlite-vec
   - Returns scored results
3. Update `src/tools/memory-store.ts`:
   - After storing memory, generate and store embedding
   - Handle embedding failure gracefully (memory still saved, embedding queued)
4. Update `src/tools/memory-search.ts`:
   - Add vector search alongside FTS5
   - For now, return both result sets separately (blending comes in Prompt 6)

### Files to Create
- `src/embeddings/openai.ts`
- `src/search/vector.ts`

### Files to Modify
- `src/tools/memory-store.ts` (add embedding generation)
- `src/tools/memory-search.ts` (add vector results)

### Verification
- Storing a memory also generates an embedding
- Vector search finds semantically similar memories
- Graceful degradation when OpenAI API is unavailable

---

## Prompt 5: Graph Relationships ⬜
**Complexity:** Medium | **Dependencies:** Prompt 2

### Non-Technical Explanation
Add the ability to connect memories to each other. "SIMS is read-only" relates to "Use Neon for writes" - they're connected knowledge. When you search for one, the system can follow the connection and suggest the other. Like a web of linked knowledge where finding one thread pulls up related threads.

### What to Build
1. Create `src/search/graph.ts`:
   - Create relationship between two memories
   - Traverse relationships (1 level deep by default)
   - Support relationship types: relates-to, supersedes, contradicts, depends-on
   - Score connected memories by relationship type and distance
2. Create `src/tools/memory-relate.ts`:
   - Accepts: source_id, target_id, relation_type
   - Validates both memories exist
   - Creates bidirectional relationship (A relates-to B = B relates-to A)
   - Returns confirmation

### Files to Create
- `src/search/graph.ts`
- `src/tools/memory-relate.ts`

### Verification
- Create 3 memories and relate them
- Graph traversal finds connected memories
- Relationship types are stored correctly
- Bidirectional traversal works

---

## Prompt 6: Smart Context (Blended Search) ⬜
**Complexity:** High | **Dependencies:** Prompts 3, 4, 5

### Non-Technical Explanation
This is the brain of the system. When Claude says "I'm working on a payment dashboard", the smart context tool runs all three searches (keyword, vector, graph) simultaneously, blends the scores, removes duplicates, and returns the top 10-15 most relevant memories. It's like asking a librarian who searches by title, by topic, AND by "books related to the ones you've read before" - all at once.

### What to Build
1. Create `src/search/blend.ts`:
   - Accept results from FTS5, vector, and graph
   - Normalize scores to 0-1 range
   - Blend: FTS5 (40%) + Vector (40%) + Graph (20%)
   - Deduplicate (same memory from multiple sources)
   - Rank and return top N
2. Create `src/tools/memory-context.ts`:
   - Accepts: task_description, limit? (default 15)
   - Runs FTS5 search on task description keywords
   - Runs vector search on task description embedding
   - Runs graph traversal on FTS5+vector matches
   - Calls blend to merge and rank
   - Returns formatted context block (ready for Claude to consume)

### Files to Create
- `src/search/blend.ts`
- `src/tools/memory-context.ts`

### Verification
- Store 20+ diverse memories
- memory_context returns relevant subset (not all 20)
- Results are ranked sensibly
- Different search types contribute different results
- Token count of response is reasonable (under 2K tokens for 15 results)

---

## Prompt 7: Memory Management (Update, Forget, Conflicts) ⬜
**Complexity:** Medium | **Dependencies:** Prompt 4

### Non-Technical Explanation
Add the ability to update memories when facts change, remove memories that are wrong, and detect when two memories contradict each other. Like being able to correct your notes, throw away outdated ones, and get alerted when your notes say two different things about the same topic.

### What to Build
1. Create `src/tools/memory-update.ts`:
   - Accepts: id, content?, why?, tags?, confidence?
   - Updates memory fields
   - Re-generates embedding if content changed
   - Updates FTS5 index
2. Create `src/tools/memory-forget.ts`:
   - Accepts: id
   - Removes from memories, tags, relationships, FTS5, embeddings
   - Cascading delete
3. Add conflict detection to `memory-store.ts`:
   - Before storing, check for high-similarity existing memories (vector search, threshold > 0.92)
   - If found, return a warning: "Similar memory already exists: [content]. Store anyway?"
   - If relation_type would be "contradicts", flag it

### Files to Create
- `src/tools/memory-update.ts`
- `src/tools/memory-forget.ts`

### Files to Modify
- `src/tools/memory-store.ts` (add conflict detection)

### Verification
- Update a memory, confirm FTS5 and embedding are refreshed
- Forget a memory, confirm all references cleaned up
- Storing a near-duplicate triggers a warning

---

## Prompt 8: Session Management ⬜
**Complexity:** Low | **Dependencies:** Prompt 2

### Non-Technical Explanation
Track work sessions - when Claude starts working on a project, what was done during the session, and what the state was when we left. Like a logbook that records "On March 11, we worked on the payment dashboard on branch feat/payments. Made 3 commits." This helps Claude pick up where you left off next time.

### What to Build
1. Create `src/tools/session.ts`:
   - `session_start`: Creates session record, returns recent sessions + project state
   - `session_end`: Updates session with summary, end time, commit count
   - `session_list`: Returns recent sessions for a project
2. Session start should return:
   - Last 3 sessions (what was worked on recently)
   - Memories with highest access count (most important knowledge)
   - Any memories marked with confidence "outdated" (needs attention)

### Files to Create
- `src/tools/session.ts`

### Verification
- Start session, end session, list sessions
- Session start returns useful context
- Multiple sessions are tracked correctly

---

## Prompt 9: Codebase Scanner (memory_init) ⬜
**Complexity:** High | **Dependencies:** Prompts 2, 4, 5

### Non-Technical Explanation
The auto-learning feature. When you first connect the memory server to a project, it reads through the codebase and builds its own knowledge: reads CLAUDE.md for rules, MEMORY.md for existing knowledge, docs for specs, git history for what's been built, and migration files for database schemas. Like a new team member reading through all the project documentation on their first day.

### What to Build
1. Create `src/scanner/markdown.ts`:
   - Parse CLAUDE.md and MEMORY.md
   - Extract rules, preferences, lessons as individual memories
   - Tag with appropriate categories
2. Create `src/scanner/git.ts`:
   - Read recent git log (last 50 commits)
   - Extract branch info, recent activity
   - Identify patterns in commit messages
3. Create `src/scanner/schema.ts`:
   - Read migration SQL files
   - Extract table names, columns, types
   - Store as "fact" memories tagged with "schema"
4. Create `src/scanner/codebase.ts`:
   - Orchestrates all scanners
   - Reads project structure (file tree)
   - Identifies tech stack from package.json
   - Creates project identity memory
5. Create `src/tools/memory-init.ts`:
   - Accepts: project_path
   - Runs codebase scanner
   - Returns summary: "Learned X rules, Y facts, Z decisions from your project"

### Files to Create
- `src/scanner/markdown.ts`
- `src/scanner/git.ts`
- `src/scanner/schema.ts`
- `src/scanner/codebase.ts`
- `src/tools/memory-init.ts`

### Verification
- Run memory_init on Ripple Suite
- Confirm it extracts rules from CLAUDE.md
- Confirm it learns database schemas from migrations
- Confirm it reads git history
- Confirm memories are searchable after init

---

## Prompt 10: Health Check + Polish + Integration ⬜
**Complexity:** Medium | **Dependencies:** All previous

### Non-Technical Explanation
Add the project health check tool, polish everything, write the CLAUDE.md for the koda-memory project itself, and test the full integration with Ripple Suite's `.mcp.json`. This is the final step: making sure everything works together and the server is ready for daily use.

### What to Build
1. Create `src/tools/health.ts`:
   - Accepts: project_path
   - Checks: git status, uncommitted changes, current branch
   - Checks: pending migrations (compares migration files vs applied)
   - Checks: package.json dependencies (any missing?)
   - Returns structured health report
2. Create `CLAUDE.md` for koda-memory project
3. Update Ripple Suite's `.mcp.json` to include memory server
4. Run full integration test:
   - Start server via MCP
   - Run memory_init on Ripple
   - Store, search, context, update, forget
   - Session start/end
   - Health check
5. Memory hygiene: add auto-archive for memories not accessed in 60+ days

### Files to Create
- `src/tools/health.ts`
- `CLAUDE.md` (for koda-memory project)

### Files to Modify (in Ripple Suite)
- `.mcp.json` (add memory server entry)

### Verification
- Health check returns accurate project state
- Full tool chain works end-to-end
- Memory server starts automatically when Claude Code opens Ripple
- memory_context returns useful results for real tasks

---

## Build Order Summary

```
Prompt 1: Scaffold + Database ──→ Prompt 2: MCP Server + Store/Recall
                                       ↓
                    ┌──────────────────┼──────────────────┐
                    ↓                  ↓                  ↓
              Prompt 3: FTS5     Prompt 4: Vector    Prompt 5: Graph
                    ↓                  ↓                  ↓
                    └──────────────────┼──────────────────┘
                                       ↓
                                 Prompt 6: Blend (Smart Context)
                                       ↓
                    ┌──────────────────┼──────────────────┐
                    ↓                  ↓                  ↓
              Prompt 7: Manage   Prompt 8: Sessions  Prompt 9: Scanner
                    ↓                  ↓                  ↓
                    └──────────────────┼──────────────────┘
                                       ↓
                                 Prompt 10: Polish + Integration
```

Prompts 3, 4, 5 can be built in parallel (independent search engines).
Prompts 7, 8, 9 can be built in parallel (independent features).
