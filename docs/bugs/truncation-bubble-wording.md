# Bug — "Penny didn't finish your plan" bubble wording is misleading

> **Audience:** A Claude agent picking this up cold. Read `CLAUDE.md` at the repo root first for project orientation, then this document.
>
> **Status:** Diagnosed, not fixed. Verified still present against `main` HEAD `62a4d79` on 2026-06-01.
>
> **Scope:** Trivial — string change only, ~5 lines. Smallest fix in the bug backlog.

## Where

- `src/components/ChatPanel.tsx:1682` — the truncation warning bubble copy.

## What's wrong

The current copy:

> **Penny didn't finish your plan**
> She ran out of room mid-plan and saved partial work. Click below to keep going from where she stopped.

"Ran out of room" reads like a context-window or token-limit problem. The actual cause is the `MAX_TOOL_USE_ITERATIONS = 16` cap in `src/lib/claude.ts:74` — Penny used all her tool-use loop iterations without ending her turn. It's an *iteration count* limit, not a context limit.

## Why it matters

When this fires again and someone (or a future Claude agent) reads the code expecting to find a token-limit issue, they'll chase the wrong thing. Misleading internal-state language is the kind of cruft that compounds across debugging sessions.

## Fix shape

Reword the bubble body. Two options:

```
**Penny didn't finish your plan**
She hit her planning step limit mid-plan and saved partial work. Click below to keep going from where she stopped.
```

Or shorter:

```
**Penny didn't finish your plan**
She needed more steps than she had this turn — partial work is saved. Continue from where she stopped.
```

Either is fine. Pick whichever reads better in the rendered UI. Don't change the heading ("Penny didn't finish your plan") — that's still accurate.

## Acceptance criteria

- `ChatPanel.tsx:1682` (or thereabouts — line may shift) no longer says "ran out of room."
- No other code changes needed; user-facing string only.
- `npx tsc --noEmit` + `npm run test` pass.

## State at handoff

- Sam's `main` may have uncommitted staged changes from earlier sessions — check `git status` before starting. Per `[[user_multi_agent_git_workflow]]`, resolve or set aside before committing.
- This is small enough to bundle into another small UI commit if one is already in progress. If shipping standalone, fine — it's 5 lines.

## Memories to honor

- `[[feedback_prefer_simple_deterministic]]` — string change, can't get simpler.
- `[[feedback_flag_stale_code]]` — if while in `ChatPanel.tsx` you spot other misleading internal-language strings, tell Sam.
