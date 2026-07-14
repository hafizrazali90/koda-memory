# Koda Memory — Project Memory Pointer

Durable knowledge for this repo lives in Koda itself (project tag `koda-memory`), not here. This file is a pointer, not a knowledge store — search Koda first.

## Current State (2026-07-13)

- Live, fixed, and verified at commit `462e17f` on `koda.tutorla.tech` (KVM8/staging, 72.62.251.97). All local, origin, and server copies in sync, zero uncommitted diffs.
- Dashboard email-login + Users management feature: fully built, guarded, tested, deployed.
- Security: admin-gate bypass fixed, `project_health`/`auto_archive` cross-user leak fixed, 11/12 npm audit vulnerabilities patched (1 remaining is low-severity, Windows-only, unreachable in this deployment).
- Search: `vectorSearch()` now respects `tags`/`category`/`project` (previously silently ignored whenever FTS had zero hits). `project` added as a first-class filter across `memory_search`/`memory_context`/`project_health`, with `normalizeProject()` folding known naming drift.
- Test suite: 268/268 passing locally and on the server.
- **Resolved same day**: the `devtools` (178.105.120.34) diverged Koda instance was reconciled into KVM8 via issue #8 / PR #9 (`scripts/reconcile-databases.ts`) — devtools-only memories preserved, devtools' pm2 process stopped (backups retained). KVM8 is now the sole canonical instance.

## Pending Work

None known as of 2026-07-13.

## Quick Rules

- Restart env-var changes with `pm2 restart ecosystem.config.cjs --update-env` (not `pm2 restart koda-memory` by name — it won't pick up new keys).
- Always take a fresh verified backup (`scripts/backup-db.ts`) before any production data mutation.
- Test the vector-search path by mocking `../embeddings/openai.js` — the real key is deleted in test-setup, so untested vector logic ships silently otherwise.

## Key References

- Koda project tag: `koda-memory`
- Canonical instance: `koda.tutorla.tech` / KVM8 (`ssh staging`)
- `docs/CODEX-HANDOFF-devtools-instance.md` — historical record of the devtools divergence and its resolution
