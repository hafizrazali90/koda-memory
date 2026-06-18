# Koda Improvement Roadmap

**Date:** 2026-06-18  
**Based on:** Full source audit of all 14 source files  
**Current version:** 0.1.0  

## Status

**ALL ROADMAP ITEMS SHIPPED 2026-06-18.**

- **Sprint 1 (retrieval quality) — SHIPPED:** P9, P8, P1, P2
- **Sprint 2 (correctness + safety) — SHIPPED:** P7, P5, P6
- **Sprint 3 (governance) — SHIPPED:** P4, P3
- **Sprint 4 (bi-temporal) — SHIPPED:** P10

Schema migrations applied to production `brain.db` on KVM8 (idempotent, run on startup):
- Migration 3 (`human_reviewed_at`) — backup `/opt/koda/brain.db.bak-pre-sprint2-20260618-142016`
- Migration 4 (`created_by`, `flagged_outdated_by`, `flagged_outdated_at`) — backup `/opt/koda/brain.db.bak-pre-sprint3-20260618-143939`
- Migration 5 (`superseded_at`) — backup `/opt/koda/brain.db.bak-pre-p10-20260618-145503`

New tools / behavior:
- `memory_flag` — any authenticated user can flag/unflag any visible memory as outdated for
  human review (no ownership check, no delete, no confidence change). Surfaces in
  `project_health.memory.flagged_for_review`.
- `memory_relate` with `relation_type: 'supersedes'` now end-dates the target: sets
  `superseded_at`, marks it `outdated`, and excludes it from search/context (still
  retrievable by id, surfaced in `project_health.memory.superseded_count`).
- `memory_recall` now returns provenance + temporal fields (`created_by`, `human_reviewed_at`,
  `flagged_outdated_by/at`, `superseded_at`).


---

## Background

This roadmap was produced after a full read of the Koda codebase and comparative research against mem0, Zep, LangMem, and Letta. Items are ordered by impact-to-effort ratio. All file references are to `src/`.

---

## Priority 1 — Fix `memory_search` blending (2–3 hours, High impact)

**File:** `tools/memory-search.ts` lines 34–53

**Problem:**  
`memory_search` — the tool agents call on every task start — does not use the blender. It runs FTS and vector in parallel, then uses first-writer-wins: FTS results populate the map first, vector only fills gaps. A memory that ranks 1st in vector but 3rd in FTS gets the FTS score only. The graph signal is never consulted here (only `memory_context` uses `blendResults`).

`memory_context` correctly calls `blendResults`. `memory_search` should too.

**Fix:**  
Replace lines 34–53 in `memory-search.ts` with a call to `blendResults(ftsResults, vecResults, [], limit)`, then enrich the blended IDs from SQLite. Set `source: 'blended'` when both signals contributed.

**Why it matters:**  
Agents call `memory_search` on every non-trivial task. When the wrong memory surfaces (because FTS beat a better semantic match), the wrong rule gets applied.

---

## Priority 2 — Add recency decay to blend score (1–2 hours, High impact)

**File:** `search/blend.ts` lines 15–57

**Problem:**  
The blend is purely relevance-based: FTS 40% + vector 40% + graph 20%. A rule written 2 years ago scores the same as one written last week if their semantic similarity is identical. `created_at` and `updated_at` exist in the schema but are never used in ranking.

**Fix:**  
Add a `recencyScore = Math.exp(-ageDays / 365)` calculation inside `blendResults`. Pass a `Map<string, string>` of `id → created_at` as an optional fourth argument. Blend weights become: FTS 36% + vector 36% + graph 18% + recency 10%. Default to 0.5 (neutral) for memories without dates.

**No schema change required.**

**Why it matters:**  
The team has memories spanning 2+ years. A superseded staging URL should rank lower than the current one automatically, without anyone manually archiving the old one.

---

## Priority 3 — Project memory provenance + flag-as-outdated (1 day, High impact)

**Files:** `db/schema.sql`, `tools/memory-store.ts` line 121, new tool in `index.ts`

**Problem:**  
Project-scoped memories (`user_id = 'sifututor'`) have no record of who wrote them. When a team member discovers a rule is wrong, they cannot flag it — `memory_update` and `memory_forget` both enforce `WHERE user_id = ?`, so no staff key can touch a project memory.

**Fix — two parts:**

1. Schema additions:
```sql
ALTER TABLE memories ADD COLUMN created_by TEXT;
ALTER TABLE memories ADD COLUMN flagged_outdated_by TEXT;
ALTER TABLE memories ADD COLUMN flagged_outdated_at TEXT;
```
Populate `created_by` from the original caller's `userId` in `memory-store.ts` line 121 (even when `effectiveUserId` is `'sifututor'`).

2. New MCP tool `memory_flag`:
- Accepts `id` and optional `reason`
- Sets `flagged_outdated_by` + `flagged_outdated_at` on any project memory
- No ownership check — any authenticated user can flag
- Does not change `confidence` or delete the memory
- `project_health` report should surface flagged-but-not-archived memories

**Why it matters:**  
With 8 API key holders, there is currently no path for a team member to signal "this rule is wrong" without deleting it. Governance is manual and invisible.

---

## Priority 4 — Push user-scope filter into FTS and vector search (3–4 hours, Medium impact)

**Files:** `search/fts.ts` lines 46–96, `search/vector.ts` lines 53–59

**Problem:**  
FTS and vector both search ALL users' memories, then filter by ownership in the enrichment step. If 8 of 10 FTS hits belong to other users, only 2 results are returned even though `limit = 10` was requested. The search silently under-delivers.

**Fix:**  
In `fts.ts`, add an explicit JOIN with `memories` to filter `(user_id = ? OR user_id = 'shared' OR user_id = 'sifututor')` before LIMIT. Pass `userId` as a parameter to `ftsSearch`. Do the same in `vectorSearch` — after fetching from `memory_embeddings`, join `memories` and filter by ownership before returning.

Add index: `CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id)`.

---

## Priority 5 — Fix staleness archiving paradox (2–3 hours, Medium impact)

**Files:** `tools/health.ts` lines 88–101, `db/schema.sql`

**Problem:**  
`archiveStaleMemories` uses `last_accessed < 60_days_ago` as the sole staleness signal. But `last_accessed` is updated on every search result, including passive retrieval. A wrong-but-frequently-retrieved rule never gets archived. A human-confirmed correct memory can be archived if it hasn't been searched recently.

**Fix:**  
Add `human_reviewed_at TEXT` to the schema. Update `memory_update` to set `human_reviewed_at = NOW()` whenever `confidence` is explicitly set. Change the archive query to:
- Exclude memories where `confidence = 'confirmed'` (human confirmed = exempt from auto-archive)
- Use `human_reviewed_at` as the staleness clock when set, falling back to `last_accessed`

---

## Priority 6 — Access-count + confidence signal boost (1 hour, Medium impact)

**File:** `search/blend.ts` or `tools/memory-context.ts`

**Problem:**  
High-signal memories (frequently retrieved, human-confirmed) score the same as low-signal noise with a lucky semantic hit. `access_count` and `confidence` are in the schema but unused in ranking.

**Fix:**  
After blending, apply a small signal boost:
```ts
const signalBoost = (accessCount > 5 ? 0.05 : 0) + (confidence === 'confirmed' ? 0.05 : 0);
result.score = Math.min(1.0, result.score + signalBoost);
```
Requires passing `accessCount` and `confidence` from the enrichment query into the blend step.

---

## Priority 7 — UUID IDs to fix concurrent write race (4 hours, Medium impact)

**File:** `tools/memory-store.ts` lines 29–35

**Problem:**  
ID generation uses `SELECT MAX(...) + 1`, then a separate `INSERT`. Two agents writing simultaneously read the same MAX, compute the same next ID, and one INSERT fails with a primary key conflict. This is a TOCTOU race inherent to the sequential ID approach.

**Fix:**  
Replace `generateId` with UUID-based IDs: `"mem_" + randomUUID().replace(/-/g, '').slice(0, 12)`. No schema change required (ID column is `TEXT`). Eliminates the race permanently without transactions.

---

## Priority 8 — Trim overly aggressive FTS stop-word list (2 hours, Medium impact)

**File:** `search/fts.ts` lines 12–20

**Problem:**  
The stop-word list includes `'not'`, `'no'`, `'working'`, `'work'`, `'up'`, `'out'`, `'if'` — all legitimate technical terms. Queries like `"not null"`, `"working directory"`, `"no access"` are stripped to single terms or empty, falling back to `simpleFtsSearch` silently.

**Fix:**  
Remove technical words from the stop-word list. Keep only pure grammatical words: `a`, `an`, `the`, `and`, `or`, `is`, `was`, `are`, `were`, `be`, `been`, `being`, `have`, `has`, `had`, `do`, `does`, `did`. Test with: `"not null"`, `"working directory"`, `"no auth"`, `"up migration"`.

---

## Priority 9 — Fix stale embedding on `why`-only update (30 minutes, Bug)

**File:** `tools/memory-update.ts` lines 80–84

**Problem:**  
```ts
if (input.content !== undefined) {
  reEmbedded = await storeEmbedding(db, input.id, content, why);
}
```
`storeEmbedding` concatenates `content + "\n" + why`. If `why` changes without `content` changing, the embedding is stale — it still encodes the old rationale. Semantic searches for the new rationale won't find this memory.

**Fix:**  
Change the condition to:
```ts
if (input.content !== undefined || input.why !== undefined) {
```

---

## Priority 10 — Bi-temporal superseded_at pattern (2–3 days, Strategic)

**Files:** `db/schema.sql`, `search/graph.ts`

**Problem:**  
When a rule is superseded, the old memory is manually archived or deleted. There is no first-class concept of "this fact was true from X to Y." Searches cannot distinguish between current rules and historical ones.

**Fix (simplified bi-temporal — not full Zep implementation):**  
Add `superseded_at TEXT` to `memories`. When `memory_relate` is called with `relation_type = 'supersedes'`, auto-set `superseded_at = NOW()` on the target memory and lower its `confidence` to `'outdated'`. Default search queries filter `WHERE superseded_at IS NULL`.

This gives 80% of the bi-temporal benefit at 10% of the complexity — you don't need point-in-time queries, just current vs. superseded.

---

## Implementation order recommendation

### Sprint 1 — Retrieval quality block (~1 day)
1. P9 — 30-min bug fix (do first, it's a bug)
2. P8 — FTS stop-word cleanup
3. P1 — Fix `memory_search` blending
4. P2 — Add recency decay

### Sprint 2 — Correctness + safety (~1 day)
5. P7 — UUID IDs (concurrent write safety)
6. P5 — Staleness archiving fix
7. P6 — Signal boost

### Sprint 3 — Governance (needs Hafiz input on flag-as-outdated design)
8. P4 — User-scope filter in FTS/vector
9. P3 — Project memory provenance + flag tool

### Later
10. P10 — Bi-temporal (do after P3 — superseded_at overlaps with governance work)

---

## Comparative context

| Feature | Koda (current) | After roadmap | Zep | mem0 |
|---|---|---|---|---|
| Shared team memory | ✓ (just added) | ✓ | Groups | app_id |
| Recency-weighted ranking | ✗ | ✓ P2 | ✓ native | partial |
| Stale fact detection | manual | ✓ P5+P10 | ✓ bi-temporal | ✗ |
| Concurrent write safety | ✗ | ✓ P7 | ✓ | ✓ |
| Provenance on shared memories | ✗ | ✓ P3 | ✓ | ✓ |
| Self-hosted, zero extra cost | ✓ | ✓ | ✗ (CE dead) | ✗ ($249/mo for graph) |
