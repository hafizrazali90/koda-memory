# Koda Brain — Release Test Plan

| Field | Value |
|---|---|
| Last updated | 2026-06-19 |
| Owner | Hafiz (CTO) |
| Live URL | `https://koda.tutorla.tech/dashboard/` |
| Server | KVM8 — 72.62.251.97, SSH alias `staging` |
| App path | `/opt/koda/app` |
| DB path | `/opt/koda/brain.db` |
| PM2 name | `koda` |

---

## Why this plan exists

The post-login blank page incident (2026-06-19) reached production because only
HTTP status codes were verified after deploy. The dashboard UI — login flow and
every page after it — was never exercised with Chrome DevTools before the build
went live.

Root cause: `types.ts` in the dashboard declared `Stats.total` but the API
returned `total_memories`. The shape mismatch caused `StatsPage.tsx` to
silently crash on render, producing a blank white screen with no console error.

**This plan exists so that class of bug cannot reach production again.**

---

## Document map

| Document | Purpose |
|---|---|
| `docs/qa/test-plan.md` (this file) | Release strategy, gates, test case registry |
| `docs/qa/browser-test.yaml` | Manual QA test catalog — 30 scripted browser test cases |
| `TESTING.md` (project root) | Quick-start cheat-sheet for running tests locally |
| `src/admin-api.test.ts` | Admin REST API contract tests — 16 groups, ~55 assertions |
| `src/integration.test.ts` | Full MCP tool integration suite (Vitest) |
| `src/auth.test.ts` | Auth isolation + token resolution |
| `src/concurrency.test.ts` | Concurrent write correctness |
| `src/quality.test.ts` | Search recall quality scoring |
| `src/load.test.ts` | FTS latency under 10k memory load |

---

## Platform scope

| Layer | Test type | Coverage |
|---|---|---|
| MCP tools (14 tools via `/mcp`) | `integration.test.ts` (Vitest) | memory_store, recall, search, context, relate, update, forget, flag, session_start/end/list, project_health, validation_run |
| Admin REST API (9 endpoints) | `admin-api.test.ts` (Vitest) | stats, memories list, memory detail, soft-delete, restore, graph, validation queue, audit, search-gaps |
| API field name contract | `admin-api.test.ts` TC-API-003 | Asserts every field in Stats response matches `dashboard/src/types.ts` |
| Auth security | `auth.test.ts` (Vitest) | Per-user isolation, token resolution, dev-mode fallback |
| Dashboard UI (7 pages) | `browser-test.yaml` (manual) | Login, Overview/Stats, Memories, Memory Detail, Graph, Validation, Audit |
| Concurrency | `concurrency.test.ts` | Concurrent store/search don't deadlock |
| Performance | `load.test.ts` + `admin-api.test.ts` TC-API-016 | FTS P99 <100ms at 10k rows; admin API P99 <200ms |

---

## Entry criteria (before starting a deploy)

- [ ] All Vitest tests pass: `npm test` exits 0
- [ ] TypeScript compiles: `npm run build` exits 0
- [ ] Dashboard builds: `cd dashboard && npm run build` exits 0
- [ ] No `console.error` in dashboard build output
- [ ] All changed code has tests for new/changed behavior

---

## Exit criteria (deploy is complete when)

- [ ] Gate 1 (automated) — all tests green
- [ ] Gate 2 (API smoke) — all curl checks pass
- [ ] Gate 3 (UI smoke) — TC-AUTH-001, TC-AUTH-003, TC-AUTH-004, TC-NAV-003 all pass
- [ ] Gate 4 (post-deploy) — `/health` returns ok, stats API returns data
- [ ] No JS `console.error` in browser after login

---

## Risk tiers

| Tier | Description | Examples |
|---|---|---|
| S1/P1 — Critical | Silent failure, user locked out, data loss | Blank page after login; auth bypass; memory store silently failing |
| S1/P2 — High | Wrong data shown, security isolation broken | Wrong user sees another's memories; stats showing wrong counts |
| S2/P1 — Medium-High | Feature non-functional but recoverable | Validation queue stuck; graph page crashing; pagination broken |
| S2/P2 — Medium | Degraded UX, non-critical failures | Slow stats load; audit log missing entries; wrong confidence label |
| S3/P3 — Low | Cosmetic | Wrong color on confidence bar; minor layout issue |

---

## Automated test suites — current baseline

| Suite | Tests | Pass | Fail | Notes |
|---|---|---|---|---|
| `auth.test.ts` | 17 | 17 | 0 | — |
| `db/connection.test.ts` | 10 | 10 | 0 | Schema migrations 1–12 |
| `integration.test.ts` | 46 | 46 | 0 | All 14 MCP tools |
| `quality.test.ts` | 26 | 26 | 0 | Recall@5 ≥70%, Recall@10 ≥80% |
| `concurrency.test.ts` | 6 | 6 | 0 | — |
| `load.test.ts` | 4 | 4 | 0 | FTS P99 0.27ms at 10k rows |
| `admin-api.test.ts` | ~55 | — | — | NEW — runs against real HTTP server |
| **Total** | **164+** | — | — | — |

---

## Required test gates before every deploy

### Gate 1 — Automated tests

```bash
cd /opt/koda/app   # or your local clone
npm test
```

**Pass criteria**: exit 0, 0 failures, 0 unexpected skips.

Minimum assertions that MUST pass (cannot be risk-accepted):

| Test | Why mandatory |
|---|---|
| TC-API-003: Stats field names | Catches blank-page class of bug |
| TC-API-004: Memories field names | Catches `pages` vs `total_pages` mismatch |
| TC-API-002: Auth rejection | Confirms 401 on missing/wrong token |
| `auth.test.ts` all | Per-user isolation must hold |
| `integration.test.ts` all | Core MCP tools must not regress |
| `concurrency.test.ts` all | Must not deadlock under concurrent load |

### Gate 2 — API smoke tests (curl, ~3 min)

Replace `$KEY` with a valid API key from `ecosystem.config.cjs` on KVM8.

```bash
BASE="https://koda.tutorla.tech"
KEY="<your-api-key>"

echo "=== Health (no auth required) ==="
curl -sf "$BASE/health" | jq '{status,version}'
# Expected: {"status":"ok","version":"0.1.0"}

echo "=== Auth rejection ==="
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$BASE/admin/stats")
echo "Status (should be 401): $STATUS"
[ "$STATUS" = "401" ] && echo "PASS" || echo "FAIL"

echo "=== Stats — field name contract ==="
curl -sf -H "Authorization: Bearer $KEY" "$BASE/admin/stats" | jq '{
  total_memories,
  flagged_count,
  superseded_count,
  deleted_count,
  validation_queue_depth,
  search_gaps_count,
  recent_audit_count,
  by_user_type: (.by_user | type),
  by_project_type: (.by_project | type),
  by_confidence_type: (.by_confidence | type),
  by_category_type: (.by_category | type)
}'
# Expected: all fields present, by_user/project/confidence/category type = "object" (NOT "array")

echo "=== Memories list — field name contract ==="
curl -sf -H "Authorization: Bearer $KEY" "$BASE/admin/memories?limit=2" | jq '{
  has_memories: (has("memories")),
  has_total: (has("total")),
  has_page: (has("page")),
  has_limit: (has("limit")),
  has_pages: (has("pages")),
  NOT_per_page: (has("per_page") | not),
  NOT_total_pages: (has("total_pages") | not)
}'
# Expected: all true

echo "=== Graph ==="
curl -sf -H "Authorization: Bearer $KEY" "$BASE/admin/graph" | jq '{nodes_count: (.nodes|length), links_count: (.links|length)}'
# Expected: both keys present, numeric counts

echo "=== Validation queue ==="
curl -sf -H "Authorization: Bearer $KEY" "$BASE/admin/validation/queue" | jq '{total,jobs_count:(.jobs|length)}'
# Expected: total is number

echo "=== Audit log ==="
curl -sf -H "Authorization: Bearer $KEY" "$BASE/admin/audit" | jq '{entries_count:(.entries|length)}'
# Expected: entries key present

echo "=== Search gaps ==="
curl -sf -H "Authorization: Bearer $KEY" "$BASE/admin/search-gaps" | jq '{gaps_count:(.gaps|length)}'
# Expected: gaps key present

echo "=== 404 on unknown route ==="
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $KEY" "$BASE/admin/unknown-route-xyz")
echo "Status (should be 404): $STATUS"
[ "$STATUS" = "404" ] && echo "PASS" || echo "FAIL"
```

**Pass criteria**: all `jq` commands produce output with expected keys present, no `error` key in any body, both 401 and 404 checks return expected codes.

### Gate 3 — Dashboard UI smoke tests (manual browser, ~8 min)

Run cases from `docs/qa/browser-test.yaml`. **Always open Chrome DevTools Console first** before navigating — any `console.error` is a failure.

**Mandatory cases (S1/P1 — cannot deploy if any fail):**

| Test ID | Name | Critical path |
|---|---|---|
| TC-AUTH-001 | Login page renders without auth | Confirms no auth-wall on login page (the other blank-page bug) |
| TC-AUTH-003 | Wrong key → error not blank | Confirms error handling |
| TC-AUTH-004 | Correct key → Overview with stats | **PRIMARY REGRESSION GUARD for 2026-06-19** |
| TC-STATS-001 | Stats page shows all 8 stat cards | Confirms StatsPage renders correctly |
| TC-MEM-001 | Memories page loads | Confirms MemoriesPage renders |
| TC-MEM-006 | Memory detail opens | Confirms MemoryDetail renders |
| TC-GRAPH-001 | Graph page canvas renders | Confirms no react-force-graph crash |
| TC-VAL-001 | Validation page renders | Confirms ValidationPage renders |
| TC-AUDIT-001 | Audit page renders | Confirms AuditPage renders |
| TC-NAV-003 | All 5 pages navigate without blank | Covers full navigation regression |

**Recommended additional cases (S2/P1 — run for major releases):**

TC-AUTH-005, TC-AUTH-006, TC-AUTH-007, TC-STATS-002, TC-STATS-003, TC-STATS-006, TC-MEM-002, TC-MEM-003, TC-MEM-004, TC-MEM-007, TC-VAL-002, TC-AUDIT-002, TC-NAV-001, TC-NAV-002

**Go/no-go rule**: if ANY mandatory case fails → deploy is blocked. Fix and rerun all mandatory cases before proceeding.

### Gate 4 — Post-deploy verification

Run from KVM8 after `pm2 reload koda`:

```bash
# Confirm PM2 status
pm2 list | grep koda

# Confirm correct commit
cd /opt/koda/app && git log --oneline -1

# Confirm dashboard dist was refreshed
ls -la /opt/koda/app/dashboard/dist/index.html
# Timestamp should match the deploy time

# Confirm health
curl -sf https://koda.tutorla.tech/health | jq .

# Confirm DB path is correct (not a wrong/temp path)
pm2 env koda 2>/dev/null | grep KODA_DB_PATH || echo "KODA_DB_PATH not set — check ecosystem.config.cjs"
```

---

## Release-gate case matrix

### Automated (Gate 1 + Gate 2)

| Risk tier | Test | Automation |
|---|---|---|
| S1/P1 | TC-API-002 Auth rejection (401) | `admin-api.test.ts` |
| S1/P1 | TC-API-003 Stats field names | `admin-api.test.ts` |
| S1/P1 | TC-API-004 Memories field names | `admin-api.test.ts` |
| S1/P1 | TC-API-008 Soft-delete + restore lifecycle | `admin-api.test.ts` |
| S1/P1 | TC-API-015 10 concurrent stats requests | `admin-api.test.ts` |
| S1/P1 | All auth.test.ts | `auth.test.ts` |
| S1/P1 | All integration.test.ts | `integration.test.ts` |
| S1/P1 | All concurrency.test.ts | `concurrency.test.ts` |
| S2/P1 | TC-API-005 Pagination | `admin-api.test.ts` |
| S2/P1 | TC-API-006 Filtering | `admin-api.test.ts` |
| S2/P1 | TC-API-007 Memory detail | `admin-api.test.ts` |
| S2/P1 | TC-API-009 Graph endpoint | `admin-api.test.ts` |
| S2/P1 | TC-API-016 Response time <200ms | `admin-api.test.ts` |
| S2/P2 | quality.test.ts Recall@5 ≥70% | `quality.test.ts` |
| S2/P2 | load.test.ts FTS P99 <100ms | `load.test.ts` |

### Manual (Gate 3)

| Risk tier | Test | Owner |
|---|---|---|
| S1/P1 | TC-AUTH-001 Login page renders | Hafiz or Codex |
| S1/P1 | TC-AUTH-003 Wrong key → error | Hafiz or Codex |
| S1/P1 | TC-AUTH-004 Correct key → Overview | Hafiz |
| S1/P1 | TC-STATS-001 All stat cards visible | Hafiz or Codex |
| S1/P1 | TC-MEM-001 Memories list loads | Hafiz or Codex |
| S1/P1 | TC-MEM-006 Memory detail opens | Hafiz or Codex |
| S1/P1 | TC-GRAPH-001 Graph canvas renders | Hafiz or Codex |
| S1/P1 | TC-VAL-001 Validation page renders | Hafiz or Codex |
| S1/P1 | TC-AUDIT-001 Audit page renders | Hafiz or Codex |
| S1/P1 | TC-NAV-003 All 5 pages without blank | Hafiz |

---

## Test case quality rules

1. **Never assume data exists**: test assertions that list data must also cover the empty-state path (e.g. "table renders OR shows 'No memories'")
2. **Always check console**: open DevTools console before every UI test run — a blank page with no console error is a different failure mode than one with a crash
3. **Never hardcode memory IDs** in UI test steps — the test must work with whatever data is in the DB
4. **Field-name tests are mandatory** for every new admin endpoint — add assertions for both what SHOULD be present and what should NOT (the "negative guard")
5. **Run Gate 2 after every hot-fix push** — it takes 3 minutes and catches the most common deploy regressions

---

## Known gaps and closure plan

| # | Gap | Risk | Priority | Close by |
|---|---|---|---|---|
| G-01 | No Playwright/automated UI tests — all TC-UI-* are manual | S1/P1 bugs reach prod | High | Next sprint |
| G-02 | Dashboard `types.ts` not imported/validated by server build | Type drift possible | High | Implement shared types package |
| G-03 | ~~Admin API field names not tested~~ | ~~S1/P1~~ | ~~High~~ | **CLOSED** — `admin-api.test.ts` TC-API-003/004 |
| G-04 | Validation engine LLM path untested (no OPENAI_API_KEY in CI) | Detector silently skipped | Medium | Mock LLM response in test |
| G-05 | No test for MCP tool responses through real HTTP (only tool-function level) | Protocol mismatch | Medium | Add `mcp-protocol.test.ts` |
| G-06 | Dashboard build not part of automated CI | Vite config errors slip through | Medium | Add `npm run build` to CI |
| G-07 | No load test for concurrent MCP sessions (SSE/Streamable) | Unknown session limit | Low | When traffic grows |

### Closing G-01 (Playwright) — recommended next step

Add a `playwright.config.ts` that:
1. Points at `https://koda.tutorla.tech/dashboard/`
2. Uses `KODA_API_KEY` env var for auth (stored in CI secrets)
3. Automates TC-AUTH-001, TC-AUTH-003, TC-AUTH-004, TC-STATS-001, TC-NAV-003

This would convert the 5 most critical manual test cases to automated checks, giving the biggest regression-detection bang per hour of implementation.

### Closing G-04 (LLM validation path)

In `src/validation/duplicate-detector.test.ts` and `contradiction-detector.test.ts`:
1. Use `vi.mock('../llm/client.js', ...)` to return deterministic responses
2. Assert the detector correctly classifies the mocked LLM output
3. Assert that when `OPENAI_API_KEY` is absent, detection still runs in FTS-only mode (no crash, lower threshold)

---

## Defect workflow

Every failed test case must be documented with:
- Test case ID
- Actual result (exact error message or screenshot)
- Expected result
- Severity/priority
- Root cause hypothesis
- Fix decision: fix now / defer with approval
- Re-test result after fix

Severity S1/P1 failures are **not deferrable** — they must be fixed before production goes live.

---

## Go / no-go rule

**DEPLOY IS BLOCKED if**:

- `npm test` has any failure
- `npm run build` has any TypeScript error
- `cd dashboard && npm run build` fails
- Any Gate 2 curl returns unexpected HTTP status or JSON `error` key
- TC-AUTH-004 fails (blank page after correct key = the incident from 2026-06-19)
- TC-NAV-003 fails (any of the 5 pages shows blank)
- Any S1/P1 manual test case returns FAIL or BLOCKED

**DEPLOY CAN PROCEED if**:

- All Gate 1 automated tests pass
- All Gate 2 API smoke checks pass
- All 10 mandatory Gate 3 UI cases pass
- Gate 4 post-deploy health check passes

---

## Incident record

| Date | Incident | Root cause | Fix | Prevention |
|---|---|---|---|---|
| 2026-06-19 | Blank page after login on `/dashboard/` after Phase 4 deploy | `types.ts` Stats interface had wrong field names (`total` not `total_memories`, `by_user` as array not Record) | Fixed `types.ts` + rewrote `StatsPage.tsx` to use correct field names | `admin-api.test.ts` TC-API-003 + TC-API-004 |
| 2026-06-19 | Blank page on initial load (before login) | Dashboard served behind auth middleware — browser couldn't load HTML/JS | Moved `/dashboard/*` static serving BEFORE auth check in `index.ts` | TC-AUTH-014 (401 on dashboard static files is now a test failure) |
