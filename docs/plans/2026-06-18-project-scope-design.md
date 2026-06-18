# Koda — Shared Team Brain (Project Scope) Design Doc

**Date:** 2026-06-18  
**Author:** Hafiz (via Claude Code)  
**Status:** Shipped — live on KVM8

---

## Problem

Every memory in Koda was personal. If Hafiz's Claude learned that all SIMS queries must include `deleted_at IS NULL`, only Hafiz's sessions could see that rule. A new developer's AI started from zero — no access to prior decisions, contracts, or gotchas.

With 8+ developers using Koda, organizational knowledge was siloed per-person.

---

## Decision

Add a `scope` parameter to `memory_store`. When `scope = "project"`, the memory is stored under `user_id = "sifututor"` — a shared namespace readable by every authenticated team member.

| Scope | user_id stored | Who can read |
|---|---|---|
| `"personal"` (default) | caller's user_id | Only the caller |
| `"project"` | `sifututor` | Every authenticated dev |

No new table, no new service, no external dependency.

---

## What changed

### `src/index.ts`
Added `scope: z.enum(['personal', 'project']).optional()` to `memory_store` tool schema.

Handler now computes `effectiveUserId` before writing:
```ts
const effectiveUserId = params.scope === 'project' ? 'sifututor' : userId;
const result = await memoryStore(db, project, effectiveUserId, params);
```

### `src/tools/memory-search.ts`
Both SQL user_id filters extended from 2-way to 3-way OR:
```sql
-- Before
(user_id = ? OR user_id = 'shared')

-- After
(user_id = ? OR user_id = 'shared' OR user_id = 'sifututor')
```

### `src/tools/memory-context.ts`
Same change — the single user_id filter now includes `'sifututor'`.

### Unchanged (intentionally)
- `memory-forget.ts` — `WHERE user_id = ?` protects project memories from deletion (no staff key maps to `sifututor`)
- `memory-update.ts` — same ownership guard; project memories cannot be overwritten by individuals
- `memory-store.ts` — no change needed; accepts `userId` from caller

---

## When to use project scope

Use `scope: "project"` for:
- Architectural decisions (auth patterns, API contracts)
- Rules that apply to all projects (SIMS soft-delete requirement)
- Gotchas every developer must know (server aliases, DB credentials format)
- Onboarding-critical knowledge

Omit scope (personal, default) for:
- Your own session corrections
- Personal workflow preferences
- Anything specific to your individual context

---

## Known gaps (see ROADMAP.md)

- No provenance — `created_by` not recorded on project memories
- No flag-as-outdated mechanism for team members
- Concurrent write race on ID generation (affects all `memory_store`, not just project scope)

---

## Deployment

- Built: `npm run build` in `/tmp/koda-memory/`
- Deployed: `rsync dist/ staging:/opt/koda/app/dist/`
- Restarted: `pm2 restart koda-memory` on KVM8 (72.62.251.97)
- Verified: startup logs clean, `sifututor` present in deployed SQL filters
