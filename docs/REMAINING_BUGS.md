# Remaining Bugs — Index

> **STALE — do not treat as a live list (noted 2026-08-19).** Everything below
> was written on 2026-06-01 and last verified against HEAD `62a4d79`. Since
> then the app pivoted to Google-only data sources, the fuel pipeline was
> rebuilt on OSM/OSRM, and the PR-based CI pipeline landed. Re-verify any entry
> against current `main` before starting it; several may already be fixed or
> obsolete. Delete this banner when the list has been triaged.

> **Context:** Cleanup list from the debugging session on 2026-06-01. Each bug below now has its own self-contained spec file in `docs/bugs/` — one per chat / agent. Per `[[user_multi_agent_git_workflow]]`, these are parallelizable; no agent needs to coordinate with another.

## Active (each gets its own chat)

| # | File | One-liner | Size |
|---|---|---|---|
| 1 | [`docs/bugs/cache-token-logging.md`](bugs/cache-token-logging.md) | `usage_events` lumps cache tokens into `input_tokens` — cache hit rate can't be measured | M (schema + migration + repo) |
| 2 | [`docs/bugs/addleg-rest-validation.md`](bugs/addleg-rest-validation.md) | `addLeg` validator accepts rest legs with no coords / names | S (Zod refine + tests) |
| 3 | [`docs/bugs/truncation-bubble-wording.md`](bugs/truncation-bubble-wording.md) | "Ran out of room" copy misleads about an iteration-cap issue | XS (string change) |
| 4 | [`docs/bugs/continuity-noroute-surfacing.md`](bugs/continuity-noroute-surfacing.md) | `penny:continuity-repaired-noroute` is logged but not surfaced to the user | M (needs investigation, then either upstream fix or new UI state) |

## Deferred

### Bug #5 — 16-iteration truncation cap

- `src/lib/claude.ts:74` — `MAX_TOOL_USE_ITERATIONS = 16`.
- Long initial plan builds can hit this and surface "Penny didn't finish your plan."
- Sam observed on 2026-05-30 that this is no longer biting in steady-state use because the "concept of now" anchor (commit `9229e74`) made tactical edits 1-2 iterations instead of 8-10.
- **Defer until real complaints recur.** Per `[[feedback_prefer_simple_deterministic]]` and `[[project_penny_now_anchor]]`.
- Full design lives in `docs/PENNY_COST_ENGINEERING.md` Feature 5 — don't re-derive it when revisited.

## Related (not in this list)

- **Fuel-stop silent-failure bug + adaptive radius escalation** — `docs/FUEL_STOP_BUG_FIX.md`. Being handled in a separate chat.
- **Cost-engineering features** — `docs/PENNY_COST_ENGINEERING.md`. Features, not bugs. Bug #1 above is a precursor that needs to ship before most of those features can be honestly evaluated.

## Verification against `main` — 2026-06-01

All four active bugs verified still present at HEAD `62a4d79`. Re-verify before starting if you're picking this up later, in case another agent landed something.
