# Playwright MCP, and reproducing before explaining

> Moved out of `CLAUDE.md` on 2026-09-20, verbatim, when that file was cut from
> 225 KB back to a map. Nothing here was rewritten or deleted — only relocated.
> `CLAUDE.md` links here from the one-line summary that replaced it.

## Playwright MCP — use it FIRST

`.mcp.json` in the repo root registers the Playwright MCP server. When working on
anything Playwright — writing a spec, changing a locator, or diagnosing a failing
test — drive a real browser through the flow with that MCP **before** theorising
about the cause or writing a diagnostic script.

Reproduce first, then explain. Reading a CI log and reasoning about what the page
"must" be doing is how three days went into a mail-provider migration for what was
actually a React hydration crash, visible in the browser console in ten seconds.

Point it at the deployed preview (the URL is in the sticky comment at the bottom
of the PR thread — it is no longer pinned into the description, since 2026-09-04,
because it changes on every push), not a local dev server — the bugs that matter here only appear on a cold production
build.

The server runs `--headless --isolated` (since 2026-09-23), so the many agent
threads running it open no windows over Sam's screen and never touch a saved
browser profile — every session starts signed out, in memory. That is all the
preview needs: specs and manual repros sign in through the real OTP flow, code
from `POST /api/test/otp`. Anything that needs Sam's real sign-ins (App Store
Connect, Google) goes through the shared signed-in browser's CDP tools
(`mcp__browser__*`), not this server.


## Reproduce, never guess

Before naming a cause, make the failure happen. Not from a code comment, not
from a commit message, not from a plausible theory, and never from "I expect
this is fine". If it cannot be reproduced, say so plainly instead of offering a
confident explanation. The Playwright rule below is one instance of this; the
rule is general.

Two misses that earned this section, both in one session:

- The `mobile.yml` header says a wrong-account `EXPO_TOKEN` broke Mobile #1 and
  #2. That is a **postmortem of a fixed problem**, and it got restated as a live
  action item — telling Sam to change a token that was already correct, on a
  pipeline he had churned repeatedly. Read tense before quoting a comment as a
  cause.
- Two test files were failing locally and called "expect them green in CI"
  without checking. `next@14.2.35` ships no `./server` entry in its export map,
  so they would have failed the PR.

How to reproduce the things that actually differ:

- **CI-only failures.** `git worktree add --detach /tmp/x origin/<branch>`, symlink
  the root `node_modules`, run the suite there. That tree has **no
  `mobile/node_modules`** — exactly what CI's unit job has, since it runs
  `npm ci` at the root only. This reproduced PR #17's failure on the first try.
  Anything under `src/` that imports from `mobile/` passes locally and dies
  there; `src/lib/noMobileImportGuard.test.ts` blocks that class now.
- **Clock and timezone.** `TZ=UTC npx vitest run` rules it in or out in one
  command. Better: don't read the ambient clock at all — pass `now` in, the way
  `payments/states.ts` and `lib/paywallNotice.ts` do. A test that has to freeze
  time will differ between a laptop and a CI box for reasons unrelated to the
  code.
- **Production data questions.** Build a `postgres` client the way
  `scripts/lifetime-spend.ts` does. Do NOT import `src/server/db/client.ts` —
  it is `server-only` and throws under `tsx`. Read-only unless the task is
  explicitly a write.
- **New guard tests.** Mutation-check them: reintroduce the exact bug, watch the
  guard fail, restore. An unverified guard is decoration.
