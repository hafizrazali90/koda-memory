# Codex handoff — reconcile the `devtools` Koda instance

Written 2026-07-13 after a full audit/fix pass on the KVM8 Koda instance. Paste this to Codex as-is.

**Goal:** Reconcile the `devtools` Koda memory server (178.105.120.34:3848), which has silently diverged from the actively-maintained instance and is running stale, buggy code.

**Context:** There are two separate Koda deployments. `koda.tutorla.tech` (KVM8/staging host, 72.62.251.97) is the one actively maintained and just went through a full security/correctness audit and fix pass (commit `462e17f` on `hafizrazali90/koda-memory`, pushed 2026-07-13). `devtools` (178.105.120.34) is a second instance that appears to predate that work and was never kept in sync, likely a leftover from before Koda was migrated to KVM8.

**What to look at, in order:**
1. `ssh devtools` → `/opt/koda/app` — its git working tree reports "no commits yet" on `master` despite having `origin` configured to the same repo. That's not a normal state; figure out whether it's a corrupted `.git`, an incomplete initial setup, or something else, before deciding how to fix it.
2. `pm2 list` on that host shows `koda-memory` with 21 days of uptime, and `/opt/koda/brain.db` was last modified 2026-06-22 — so this instance has been frozen since around when it was first stood up, never redeployed since.
3. Compare its data against KVM8's: `/admin/stats` on devtools currently shows 1,743 memories with a user set of `hafiz, helmi, shahrooz, sifututor`; KVM8 has 2,551 memories with `hafiz, helmi, hiba, huda, mubashir, sifututor`. Notably `shahrooz` doesn't appear on KVM8 at all, and `hiba`/`huda`/`mubashir` don't appear on devtools. These are genuinely different, non-overlapping datasets, not just a version lag.
4. It's still running pre-fix code: confirmed the duplicate-project-label bug fixed on KVM8 (`scripts/dedupe-projects.ts`, commit `cbed76b`) is still present here, e.g. `"Sifututor"` and `"sifututor"` show as two separate buckets.

**What needs deciding, not just fixing:** the two databases have diverged real user data (shahrooz's memories exist only on devtools, hiba/huda/mubashir's only on KVM8). Simply repointing Codex to KVM8 would orphan shahrooz's history; simply fixing devtools in place leaves two permanently-diverged memory stores for as long as Claude Code and Codex point at different servers. This needs a decision from Hafiz on which server is canonical and whether the two datasets should be merged — don't decide this unilaterally.

**Guardrails:**
- Take a verified backup (`scripts/backup-db.ts`, WAL-safe, already in the repo) before touching `devtools`' `brain.db` in any way.
- Don't assume KVM8's fixed code can just be dropped onto devtools without checking whether the `.git` state issue in point 1 needs fixing first — a `git pull` won't behave predictably against a repo with no commit history.
- Don't merge or discard either dataset without explicit sign-off from Hafiz. This mirrors how the KVM8 duplicate-label migration was actually executed: local dry-run against a throwaway seeded DB, fresh verified backup, production dry-run matching predictions, then apply, then verify.
