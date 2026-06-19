# Koda Brain — Testing Quick Start

> Full strategy: `docs/qa/test-plan.md`
> UI test catalog: `docs/qa/browser-test.yaml`

---

## Run all automated tests

```bash
npm test
```

**Expected**: 7 test files, ~115+ tests, 0 failures, 0 skipped.

---

## What each test file covers

| File | What it tests | When to run |
|---|---|---|
| `src/db/connection.test.ts` | Schema migrations 1–12, all columns present | After any schema change |
| `src/integration.test.ts` | All 14 MCP tools end-to-end on a temp DB | Always |
| `src/auth.test.ts` | Token resolution, user map, auth rejection | After any auth change |
| `src/concurrency.test.ts` | Concurrent writes don't deadlock | After DB layer changes |
| `src/quality.test.ts` | BM25 + graph search recall ≥70% at 5 results | After search changes |
| `src/load.test.ts` | FTS P99 latency <100ms at 10k rows | After query changes |
| `src/admin-api.test.ts` | Admin REST API field names + HTTP contract | After any API or types.ts change |

---

## Run a single test file

```bash
npx vitest run src/admin-api.test.ts
npx vitest run src/integration.test.ts
```

---

## Run tests matching a description

```bash
npx vitest run --reporter=verbose -t "TC-API-003"
```

---

## Build verification (run before every deploy)

```bash
# 1. Compile TypeScript (server)
npm run build

# 2. Build dashboard
cd dashboard && npm run build && cd ..

# 3. Run all tests
npm test
```

All three must succeed with exit code 0 before any deploy.

---

## Deploy checklist

Copy and check each box before running `pm2 reload koda`:

```
Pre-deploy:
[ ] npm run build  exits 0
[ ] cd dashboard && npm run build  exits 0
[ ] npm test  exits 0 (all tests green)

Post-deploy (run from any machine with curl):
[ ] curl https://koda.tutorla.tech/health  → {"status":"ok"}
[ ] curl -H "Authorization: Bearer $KEY" https://koda.tutorla.tech/admin/stats | jq .total_memories  → number
[ ] curl -H "Authorization: Bearer $KEY" https://koda.tutorla.tech/admin/memories?limit=1 | jq '{memories_count:(.memories|length),pages}' → {memories_count:1,pages:N}

UI smoke (open browser, check console for errors first):
[ ] https://koda.tutorla.tech/dashboard/ → login page renders (TC-AUTH-001)
[ ] Wrong key shows error message, not blank (TC-AUTH-003)
[ ] Correct key → Overview with stat cards (TC-AUTH-004)  ← PRIMARY REGRESSION GUARD
[ ] All 5 nav pages render without blank screen (TC-NAV-003)
```

---

## The bug this test plan prevents

**2026-06-19 — Post-login blank page**: `types.ts` in the dashboard declared
`Stats.total` but the API returned `total_memories`. The mismatch caused
`StatsPage.tsx` to silently crash (undefined reference on render), producing a
blank white screen with no console error.

**Prevention**: `TC-API-003` in `admin-api.test.ts` now asserts every field
name in the API response, including the negative assertion that `total` and
`per_page` do NOT exist. This test runs in CI on every deploy.

---

## Adding a new admin endpoint

When you add a new `/admin/...` endpoint:

1. Add the response shape to `dashboard/src/types.ts`
2. Add a test group to `src/admin-api.test.ts` with:
   - HTTP status code assertion
   - Field name assertions for every key in the response
   - A negative assertion for any common alternative name (e.g. `total` vs `total_count`)
3. Add the endpoint to `docs/qa/browser-test.yaml` if it's surfaced in the UI
4. Re-run `npm test` — must still be green

---

## Backups (production)

The brain DB is backed up daily and on demand. **Never** back up with `cp brain.db`
— that misses the WAL and produces a silently incomplete copy (it dropped 8
memories on 2026-06-19). Always use the verified backup script.

```bash
# On KVM8 — take a verified backup now
KODA_DB_PATH=/opt/koda/brain.db npx tsx scripts/backup-db.ts
```

- Backups land in `/opt/koda/backups/brain-<timestamp>.db`, newest 14 retained.
- Each backup is verified (memory count vs source); a mismatched copy is deleted
  and the run exits non-zero.
- Daily cron: `0 3 * * * /opt/koda/backup.sh` (logs to `/opt/koda/logs/backup.log`).

### Restoring from a backup

```bash
# On KVM8
pm2 stop koda-memory
rm -f /opt/koda/brain.db-wal /opt/koda/brain.db-shm   # clear stale WAL/shm
cp /opt/koda/backups/brain-<timestamp>.db /opt/koda/brain.db
pm2 restart koda-memory
curl -sf https://koda.tutorla.tech/health    # confirm it came back up
```

## Wiping the test DB

Tests create their own temp DBs in `os.tmpdir()`. They're cleaned up automatically
when `server.close()` and `db.close()` are called in `afterAll`. You don't need
to manually clean anything.

---

## Common failures and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `admin-api.test.ts` port conflict | Another process on the test port | Tests use port 0 (OS-assigned) — if this fails, there's a deeper issue |
| `Field 'total_memories' not found` | API response shape changed | Update `types.ts` AND the test assertions together |
| `npm run build` fails with TS error | Type mismatch introduced | Fix the TypeScript error — don't use `any` to suppress it |
| Dashboard build fails | Vite config or import error | Run `cd dashboard && npm run build` locally first |
| `pm2 list` shows Koda in errored state | App crashed on startup | Check `pm2 logs koda --lines 50` on KVM8 |
