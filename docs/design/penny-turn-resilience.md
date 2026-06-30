# Penny turn resilience — the "Something went wrong. Please try again." bug

> Status: **BUILT 2026-06-30 — #1 (diagnostics) + #2–#4 fully wired.** Route lifecycle
> (`runTurnWork`/`drainQueuedTurns` in `api/trip/replan`), reconcile endpoint
> (`GET /api/trips/[id]/turns`), and client heal/poll (`ChatPanel.tsx`,
> `lib/penny/applyOutcome.ts`) all landed. Queued turns drain in-request rather than
> via `unstable_after` (unavailable in Next 14.2.35). See CLAUDE.md for the wired summary.
> Owner context: raised by Sam 2026-06-30 from a mobile screenshot during a long
> Trondheim→Tromsø replan. The error showed, then "resolved itself" on reopen.

## TL;DR

The error bubble in the screenshot is **a false failure**. The server finished the
work and saved it; only the client thought it failed, because the streaming
connection died when the app was backgrounded. There is **no data loss** — the bug
is bad client-side failure handling plus zero diagnostics, not a broken plan.

## What actually produces the message

`"Something went wrong. Please try again."` has exactly one source:
`ChatPanel.tsx` — the `catch` around the replan fetch/stream. It is **not** server
text and was never in chat history. There are four distinct client error paths,
and they each print different copy:

| Path | Trigger | Copy | Persisted? |
| --- | --- | --- | --- |
| `catch (err)` | the `fetch`/stream read **throws** (connection torn down) | "Something went wrong. Please try again." | **No** (React state only) |
| no `applied` event | stream ends cleanly, no terminal event | "Connection dropped before Penny finished…" | No |
| SSE `error` event | server emitted a real error | "Error: \<message>" | **Yes** (server `addChatMessage`) |
| pre-stream HTTP error | rate limit / validation / missing key | "Error: \<message>" | No, but actionable |

The screenshot is the first row — a **thrown exception on the client**, not a server
failure. `failAssistant()` only calls `setMessages` (React state); it writes nothing
to the DB. That is why the bubble vanishes on reopen — there was never anything to
reload.

## Why it self-heals

The server is built to not care if the client leaves. In
`api/trip/replan/route.ts` the SSE `send` is wrapped so a client disconnect flips a
`clientDisconnected` flag and swallows the enqueue error; the model loop runs to
completion and persists Penny's reply via `addChatMessage(..., 'assistant', ...)`
regardless of whether anyone is reading the stream.

**Confirmed platform behavior:** on Vercel, Node-function request cancellation is
**opt-in** via `"supportsCancellation": true` in `vercel.json`. This repo has **no
`vercel.json`**, and the replan route never reads `request.signal`. So a client
disconnect does **not** kill the function — it runs to `maxDuration` (300s; an
internal 280s budget races first and surfaces an honest "timed out" error that is
itself persisted). That is exactly why every occurrence "resolved itself": the work
reliably completes server-side.

Implication: **turns are not lost** under the current config. #4 (decoupling work
from the stream) is therefore defense-in-depth, not a correctness fix — Sam chose to
build it anyway for robustness if `supportsCancellation` is ever enabled.

## The bugs, separated

- **A — false failure (UX).** Backgrounding a streaming fetch on mobile is normal,
  not exceptional. The client treats the resulting throw as a hard error and tells
  the user to "try again" — advice that, because the server usually already
  succeeded, risks a **duplicate/conflicting edit** on retry.
- **B — diagnostic black hole.** The catch-all discarded the real error, logged only
  `console.warn` (invisible on mobile), beaconed nothing, and persisted nothing. No
  code, no trail in `/admin/errors`, nothing to investigate after the fact.

## Fix plan

### #1 — Diagnostics (BUILT)

- New `POST /api/analytics/client-error` logs client-only stream failures to
  `usage_events` (`provider = 'penny:client-stream-error'`) so they surface in
  `/admin/errors`. Diagnostics only; never mutates trip state.
- `ChatPanel` now generates a short user-facing code (`S-xxxxxx`), beacons the real
  error + lifecycle `phase` + whether the page was `hidden` (with `keepalive` so it
  survives backgrounding), and shows the code in the bubble.
- This is what lets us **confirm in production** that the cause is backgrounding
  (expect `hidden: true`, `phase: 'stream-threw'`) and measure frequency before/after
  the rest of the work.

### #2 — Reconcile on reopen (the real user-facing fix)

On stream-throw and on `visibilitychange` → visible / refocus, refetch the trip's
chat (and trip) and **heal the false error**: if Penny's turn landed, silently
replace the error bubble with her real reply. The dead-end disappears.

### #3 — Idempotency + concurrency guard (defends a real race)

With cancellation off, the first turn keeps mutating the trip for up to 300s. If the
user taps "try again" (or the client queue resends) while it is still running, two
concurrent replans edit the same trip. Guard: a per-turn **idempotency key**; the
server rejects / returns-existing when a `running` turn already exists for the trip.

### #4 — Decouple work from the stream (re-attach)

Record each turn server-side so the result does not live only in the SSE stream; a
dropped client can poll/re-attach instead of losing visibility.

## The unifying primitive: `pennyTurns`

Rather than a heavyweight job queue, #2–#4 share **one new record** per replan turn:

```
pennyTurns
  id              uuid pk
  trip_id         uuid  -> trips.id  (indexed)
  user_id         uuid  -> users.id
  idempotency_key text  unique       (client-generated per send; dedupes retries)
  status          text  'running' | 'done' | 'error'
  user_message    text
  result_response text  nullable      (Penny's final prose when done)
  result_meta     jsonb nullable      (the `applied` payload: counts, planSummary, …)
  error_message   text  nullable
  created_at / updated_at
```

How it powers each item:

- **#3** — `idempotency_key` is `unique`; a send whose key already exists returns the
  existing turn. A new send while a `running` turn exists for the trip is rejected
  (concurrency guard).
- **#4** — the route writes `running` → `done`/`error` independent of the SSE stream,
  so the outcome is durable and re-attachable.
- **#2** — a new `GET /api/trips/[id]/turns/[key]` (or latest-turn) lets the client
  poll/reconcile; on reopen it reads the record (or chat history) and heals.

New surface to add (for the #2–#4 commit, after sign-off):
- Schema: `pennyTurns` table + Drizzle migration; new `repos/pennyTurns.ts`.
- Route: `api/trip/replan` creates the record, enforces the guard, updates status.
- Route: `GET` turn-status/reconcile endpoint.
- Client: generate + send the idempotency key; reconcile on throw / `visibilitychange`.
- Update `CLAUDE.md` (Schema table count, Repos, API Routes) + tests.

## Open decisions for Sam

1. **Concurrency guard policy:** reject a second concurrent send with a friendly
   "Penny's still working on your last message…", or queue it? (Reject is simpler and
   matches the existing client-side message queue.)
2. **Reconcile trigger:** `visibilitychange` + on-throw is enough; do we also want a
   short poll while a turn is `running` so the UI updates even without a reopen?
3. **Retention:** `pennyTurns` rows are transient diagnostics-grade — prune after N
   days, or keep for audit?

## Troubleshooting guide (for future "Something went wrong" reports)

1. Get the **code** from the bubble (`S-xxxxxx`) if present.
2. Check `/admin/errors` for `penny:client-stream-error`. `hidden: true` +
   `phase: 'stream-threw'` ⇒ backgrounding (benign; work almost certainly saved).
3. Confirm the turn landed: the trip's chat history will contain Penny's assistant
   reply even though the client showed an error.
4. A `penny:client-stream-error` with `hidden: false` is more interesting — that is a
   real network/stream fault worth investigating, not just backgrounding.
5. Server-side faults appear under `provider = 'anthropic:replan'` (success=false)
   and are already persisted as a chat bubble with the real message.
