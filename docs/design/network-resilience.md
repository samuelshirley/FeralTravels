# Network Resilience Design Doc

**Author:** Claude (with Sam)
**Date:** 2026-05-21
**Status:** Draft — scoping complete, awaiting decision points before implementation

---

## Problem

Trip Planner is built for overlanders who will frequently be on terrible connections — bad cell, satellite internet (Starlink), dead zones between towns. Today, every network hiccup produces either a cryptic error modal, a silently swallowed failure, or an infinitely hanging request. The app needs to be more reliable than a diesel Landcruiser from the '90s: errors and bad experiences should never happen when this launches.

## Current State (Audit Summary)

**What exists:**
- Chat streaming detects dropped connections and shows "Connection dropped... please retry"
- Google Directions server-side has an LRU cache (200 entries, 24h TTL) and returns errors as data
- Places/fuel API calls have retry logic with backoff (3 attempts on 429/502/503)
- Server continues DB writes even after client disconnect (the `clientDisconnected` guard)
- 7 of 35 mutations have optimistic UI
- Stop mutations handle 404s gracefully when auto-replan rewrites IDs

**What's broken on bad connections:**
- Zero fetch timeouts (except `/api/coords/parse`) — hanging requests show nothing
- Zero offline detection — no `navigator.onLine`, no banner, no awareness
- Zero automatic retry on any client-side API call
- Chat stream reader hangs silently on stall — no heartbeat, no timeout
- User's typed message is cleared before fetch fires — lost on failure
- 8 mutations silently swallow errors — user thinks action succeeded
- No idempotency keys — retrying chat creates duplicate tool executions
- No service worker — zero offline capability
- No `error.tsx` or `loading.tsx` anywhere in the app
- Toast auto-dismisses in 5s with no retry button

---

## Architecture: Three-Tier Resilience Stack

Each tier depends on the one below it. They must be built in order.

### Tier 1: Foundation

The primitives that detect failure and give the user accurate information.

#### 1.1 Fetch Timeout Wrapper

Add `AbortController` timeout to `apiFetch`. The pattern already exists in `/api/coords/parse` — it's ~10 lines.

```
Default timeouts:
- GET requests: 10 seconds
- POST/PATCH/DELETE mutations: 30 seconds
- Chat stream (POST /api/trip/replan): 60 seconds initial connect, then heartbeat
- File uploads (GPX): 60 seconds
```

The timeout fires an `AbortError`, which `apiFetch` catches and classifies as a network failure (same as today's catch block, but now it actually fires instead of hanging forever).

**Implementation:** Modify `apiFetch` to create an internal `AbortController` with `setTimeout`, race it against any caller-provided signal via `AbortSignal.any()`.

#### 1.2 Offline Detection Banner

New component: `ConnectionStatus.tsx`, rendered once in the root layout alongside `ErrorNotifier`.

```
Behavior:
- Listens to window `online`/`offline` events + navigator.onLine
- On offline: fixed banner at top of viewport — "You're offline. Changes will be saved when you reconnect."
- On reconnect: banner transitions to "Back online" (green, auto-dismiss 3s)
- Exposes a React context (ConnectionContext) so any component can read isOnline
```

This is just awareness — it doesn't change behavior yet. But it eliminates the "what the hell is happening" confusion immediately.

#### 1.3 Error Handling Consistency

**Kill silent swallows.** These 8 mutations silently eat errors today:
1. `addNearbyPlace` — no catch at all
2. `setOvernight` — partial dismiss errors caught, insert failure unhandled
3. `addRoute` — silently swallowed
4. `deleteRoute` — silently swallowed
5. `addTask` — silently swallowed
6. `updateTask` — silently swallowed
7. `deleteTask` — silently swallowed
8. `findAlternative` — console.error only

Fix: every mutation must either show inline error UI or go through the global reporter. No silent failures.

**Add retry affordance to toasts.** The current 4xx toast auto-dismisses after 5s with no action. Add a "Retry" button that re-issues the failed request. Requires `apiFetch` to capture the request config so the toast can replay it.

**Add `error.tsx` boundaries.** At minimum: `src/app/error.tsx` (root) and `src/app/trips/[tripId]/error.tsx` (trip workspace). These catch React rendering crashes and show a recovery UI instead of the Next.js default.

---

### Tier 2: Reliability

Make the app work *well* on bad connections, not just *less confusingly*.

#### 2.1 Retry with Exponential Backoff

New utility: `resilientFetch` wrapping `apiFetch`.

```
Rules:
- GET requests: retry up to 3× on network error or 5xx, with jittered exponential backoff (1s, 2s, 4s ± random 0-500ms)
- Mutations (POST/PATCH/DELETE): DO NOT auto-retry (not safe without idempotency — that's Tier 3)
- 4xx errors: never retry (client error, retrying won't help)
- 429 (rate limit): retry with Retry-After header if present, else 5s delay
- AbortError (user-initiated cancel): never retry
```

This is specifically for reads. Mutation retry comes in Tier 3 via the queue.

#### 2.2 Expand Optimistic UI

Currently 7 mutations are optimistic. Expand to cover all user-initiated mutations that have a predictable outcome:

```
Already optimistic (keep as-is):
- Chat message delivery status
- Stop select / dismiss
- Route select
- Avoid-highways toggle
- Units preference
- Announcement dismiss

Add optimistic behavior:
- Task add → show task in list immediately, reconcile on response
- Task update (resolve/skip/reopen) → flip status locally
- Task delete → remove from list, restore on failure
- Stop delete → remove from list, restore on failure
- Route delete → remove from list, restore on failure
- Vehicle update → update form state locally (already has inline errors)
```

Pattern: `setLocalState(optimistic)` → `apiFetch(...)` → on success: reconcile with server response → on failure: rollback + show inline error.

NOT suitable for optimistic UI (too complex or non-deterministic):
- Stop add (server assigns ID, resolves coordinates)
- Leg add (server computes drive geometry)
- GPX upload (server processes file)
- Chat/replan (LLM response is inherently unpredictable)
- Trip create/clone (multi-table writes)

#### 2.3 Chat Stream Hardening

Three changes to `ChatPanel.tsx`:

**a) Heartbeat timeout.** If the SSE reader receives no data for 20 seconds, surface the "Connection dropped" state instead of hanging silently. The server already sends `received`, `reading`, and `tool_started` events early in the stream — if none arrive within 20s, the connection is dead.

**b) Preserve user input on failure.** Today the textarea is cleared before the fetch fires. Change: clear on first successful SSE event (`received`), not on send. If the fetch fails before any event arrives, the user's text is still in the textarea. Additionally, keep the submitted message visible in the chat bubble even on failure — don't remove it. The user should see what they sent and be able to retry it, not have their words vanish.

**c) Post-failure data refresh.** When a chat stream drops after tool execution but before `applied`, the server has committed mutations that the client doesn't know about. Add: on chat failure, trigger `loadTrip()` to pick up any server-side changes. The `clientDisconnected` guard means tools always complete — the client just needs to catch up.

---

### Tier 3: Offline-First

Make the app functional without a connection, and bulletproof with a bad one.

#### 3.1 Mutation Queue

The core offline primitive. When a mutation fails (network error, timeout, offline), instead of showing an error, queue it for retry when connectivity returns.

**Storage:** IndexedDB via a thin wrapper (not localStorage — need structured data and >5MB capacity for trip cache). One database per user, two object stores: `mutationQueue` and `tripCache`.

**Queue entry schema:**
```typescript
interface QueuedMutation {
  id: string;              // crypto.randomUUID()
  createdAt: number;       // Date.now()
  endpoint: string;        // e.g. "/api/stops/abc123"
  method: string;          // POST, PATCH, DELETE
  body: unknown;           // request payload
  idempotencyKey: string;  // for server-side dedup
  status: 'pending' | 'inflight' | 'failed';
  retryCount: number;
  lastError?: string;
  entityType: string;      // 'stop' | 'task' | 'route' | etc.
  entityId?: string;       // for conflict detection
  optimisticState?: unknown; // local state snapshot for rollback
}
```

**Drain behavior:**
```
- On `online` event: start draining
- On successful apiFetch (piggyback): check queue, start draining
- Drain processes entries FIFO
- Each entry gets its idempotency key sent as X-Idempotency-Key header
- On success: remove from queue, reconcile local state
- On 4xx: remove from queue (client error, won't succeed on retry), show error
- On 5xx/network error: increment retryCount, backoff, try next entry
- On 409 (conflict): see Conflict Resolution below
- Max 5 retries per entry, then surface to user as a failed mutation
```

**UI indicator:** Small persistent badge (like an unread count) showing queued mutations. Tapping it shows a list with status. The user should always know there are pending changes.

**DECISION POINT — Conflict Resolution Strategy:**

This is the hardest design decision. Three options:

**Option A: Last-Write-Wins (LWW)**
- Queue drains in order, server applies whatever it gets
- If Penny modified the same stop while user was offline, user's queued write overwrites Penny's
- Pro: Simple, predictable
- Con: Silent data loss if conflicts happen

**Option B: Timestamp-Based Merge**
- Each mutation carries a `clientTimestamp`
- Server compares against entity's `updated_at`
- If entity was modified after the queued mutation was created, reject with 409
- Client shows conflict to user: "This stop was updated while you were offline. Keep your version or the current version?"
- Pro: No silent data loss
- Con: More UI work, user sees conflicts

**Option C: Field-Level Merge**
- PATCH mutations carry only changed fields
- Server merges field-by-field: if the queued mutation changed `name` and Penny changed `lat/lng`, both apply
- Only conflict if same field was touched
- Pro: Most conflicts auto-resolve
- Con: Complex, edge cases in non-orthogonal fields (e.g., changing stop name + moving stop location might be semantically linked)

**Recommendation: Option B (Timestamp-Based) for v1.** It's the safest — no silent data loss. Conflicts will be rare in practice (single user, Penny only modifies things during active chat, which can't happen offline). The conflict UI is simple: a modal with "Your version" vs "Current version" for the affected entity. We can graduate to Option C later if conflicts are frequent enough to be annoying.

For deletes specifically: if the user queued "delete stop X" and it was already deleted (404), silently succeed (already idempotent). If stop X was *modified* since the delete was queued, show the conflict.

#### 3.2 Mutation Classification

Not all 35 mutations belong in the queue. Classification:

```
QUEUEABLE (safe to defer, user expects persistence):
- Stop: select, dismiss, delete, add (from paste/nearby), setOvernight, swapPrimary
- Task: add, update, delete
- Route: add, delete, select
- Vehicle: update
- Trip: update (avoid-highways toggle)
- GPX: delete
- Announcement: dismiss

NOT QUEUEABLE (require immediate server response or are too complex):
- Chat/replan (LLM streaming — needs live connection)
- Onboarding answers (state machine — needs server to advance)
- Vehicle remediation (state machine)
- Trip create (needs server ID, then navigation)
- Trip clone (multi-table deep copy)
- Trip delete (cascading, destructive — confirm only when online)
- GPX upload (file transfer)
- Fuel replenish (server-side computation)
- Stop findAlternative (server-side Places API)
- Support message (email send)
- Analytics/viewport time (fire-and-forget, already loss-tolerant)
- Admin mutations (admin is presumably on good internet)

SPECIAL CASE — Stop add:
- Queueable for paste-GPS adds (user provides lat/lng, server just inserts)
- NOT queueable for nearby-place adds (requires server Places API lookup)
```

For non-queueable mutations when offline: show a clear message — "This action requires an internet connection. It'll be available when you're back online." Disable the button/action visually.

#### 3.3 Service Worker Trip Cache

Cache trip data so the user can *view* their itinerary offline. Not edit (that's the mutation queue) — just view.

**What to cache:**
```
- GET /api/trip?tripId=X → full trip with legs
- GET /api/stops?tripId=X&legId=Y → stops per leg (for all legs)
- GET /api/routes?tripId=X&legId=Y → routes per leg
- GET /api/tasks?tripId=X → all tasks
- GET /api/pois?tripId=X → POIs
- Google Maps tiles (handled by Google's own SW, but we should ensure it's enabled)
```

**Strategy: Stale-While-Revalidate.**
- On fetch: serve from cache immediately, fire background revalidation
- On revalidation success: update cache, push new data to the page via `postMessage`
- On revalidation failure (offline): stale data stays, user sees "Last updated: 5 min ago" indicator
- Cache eviction: keep current trip + 1 most-recently-viewed trip. Evict on storage pressure.

**What NOT to cache:**
- POST/PATCH/DELETE (mutations go through the queue, not the cache)
- `/api/chat` and `/api/trip/replan` (streaming, not cacheable)
- `/api/directions` (Google Directions, but we already have server-side LRU)
- Auth endpoints

**Next.js App Router integration:** Service workers and RSC/streaming have known friction. The SW should only intercept `/api/*` routes, never RSC payloads or `_next/` assets. App Shell (the HTML) should always go to network-first — we want the latest client code, and the app is useless without JS anyway.

**Staleness indicator:** When serving cached data, show a subtle "Last synced: X minutes ago" badge in the trip workspace header. This prevents the worse problem of the user *thinking* they're seeing live data when they're not.

#### 3.4 Chat Idempotency

Prevent duplicate tool execution when a chat request is retried after a timeout or drop.

**Client side:**
- Generate a `requestId` (UUID) per chat send
- Send it as part of the POST body to `/api/trip/replan`
- On retry (manual "retry" button or auto-retry): reuse the same `requestId`
- Preserve the user's message text (see 2.3b) so retry is possible

**Server side:**

New table: `chat_request_log`
```sql
CREATE TABLE chat_request_log (
  request_id  UUID PRIMARY KEY,
  trip_id     UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL DEFAULT 'processing', -- processing | completed | failed
  result      JSONB  -- cached ReplanResult for replay
);
```

**Flow:**
1. Client sends `POST /api/trip/replan` with `requestId`
2. Server checks `chat_request_log` for this `requestId`
3. If found with `status: 'completed'`: return cached result (replay the SSE events from `result` JSONB)
4. If found with `status: 'processing'`: return 409 "Request already in progress" (client shows "Penny is still thinking...")
5. If not found: insert row with `status: 'processing'`, proceed normally
6. On completion: update row to `status: 'completed'` with the `ReplanResult`
7. On failure: update row to `status: 'failed'`

**TTL:** Rows older than 1 hour are eligible for cleanup (cron or lazy delete). The `requestId` only needs to survive long enough to catch retries, not forever.

**Chat retry button:** After a stream failure, show a "Retry" button in the assistant bubble that re-sends the same `requestId`. The server either replays the completed result or resumes if it's still processing.

---

## New Database Objects

```
1 new table:  chat_request_log (for idempotency)
0 new columns on existing tables (conflict detection uses existing updated_at)
```

The mutation queue and trip cache live in client-side IndexedDB, not Postgres.

---

## Implementation Order

```
Phase 1 — Foundation (Tier 1)                    ~2-3 days
  1. Fetch timeout wrapper in apiFetch
  2. ConnectionStatus banner component
  3. Fix 8 silent-swallow mutations
  4. Add retry button to error toast
  5. Add error.tsx boundaries

Phase 2 — Chat Hardening (Tier 2, partial)        ~1-2 days
  6. Chat stream heartbeat timeout
  7. Preserve user input on failure
  8. Post-failure data refresh

Phase 3 — Retry + Optimistic (Tier 2)             ~2-3 days
  9. resilientFetch for GET requests
  10. Expand optimistic UI to ~13 more mutations

Phase 4 — Offline Infrastructure (Tier 3)         ~3-4 days
  11. IndexedDB wrapper (mutationQueue + tripCache stores)
  12. Mutation queue with drain logic
  13. Queue UI indicator
  14. Server-side idempotency header handling
  15. Conflict detection (timestamp-based 409s)
  16. Conflict resolution UI

Phase 5 — Service Worker + Chat Idempotency       ~3-4 days
  17. Service worker for API route caching (stale-while-revalidate)
  18. Staleness indicator in trip workspace
  19. chat_request_log table + migration
  20. Chat retry with requestId dedup
  21. Chat retry button UI

Phase 6 — Polish + Testing                        ~2-3 days
  22. E2E tests with network throttling (Playwright network conditions)
  23. Manual testing on actual bad connections
  24. Edge case review (queue + Penny race, SW cache invalidation)
```

**Total estimate: ~14-19 working days** across all phases.

---

## Trade-offs and Risks

| Decision | Trade-off |
|---|---|
| IndexedDB over localStorage | More complex API, but structured queries and no 5MB limit. Needed for trip cache. |
| Timestamp-based conflicts over LWW | User sees occasional conflict modals, but no silent data loss. Worth it. |
| SW only caches /api/* routes | Simpler, avoids RSC/streaming conflicts, but means the app shell requires network. Acceptable — the app needs JS to function anyway. |
| Chat idempotency via new table | One more table to maintain, but prevents the worst failure mode (duplicate tool execution creating ghost entities). |
| Mutation queue for mutations, retry for reads | Two different patterns for two different problems. Simpler than a unified approach, clearer failure modes. |
| Not caching Google Directions client-side | Google's SDK handles its own caching; we already have server-side LRU. Adding another layer adds complexity for minimal gain. |

## What This Doesn't Solve

- **Real-time sync between devices.** This design is single-device. If the user opens the trip on their phone and laptop, they'll see different states until both refresh. Solving this requires WebSocket push or polling, which is a separate initiative.
- **Offline Penny.** Chat requires a live connection to Anthropic. There's no way around this — the LLM runs in the cloud. The best we can do is make it obvious ("Chat requires internet") and preserve the user's message for when they're back online.
- **Offline map tiles.** Google Maps has its own offline caching. We could pre-download tiles for the trip route, but that's deep in Google's SDK and a separate feature.
- **Background sync.** The SW Background Sync API could drain the mutation queue even when the app isn't open. Worth considering later, but adds complexity and has inconsistent browser support.

---

## Resolved Decisions (2026-05-21)

1. **Conflict resolution: Option B (timestamp-based, show conflicts).** No silent data loss. If a queued mutation conflicts with a server-side change, show the user both versions and let them choose. Zero silent overwrites.

2. **Offline chat: Queue message for send.** Composer stays enabled offline. User types their message, it sits in the queue with a "Will send when online" badge. Response won't come until reconnect, but the user's intent is captured immediately.

3. **Queue visibility: Both badge + inline.** Global badge in the header shows count of pending syncs. Each affected entity (stop card, task row) also shows a subtle "Pending sync" indicator. Maximum transparency.

4. **Trip delete while offline: Block it.** Show the squirrel error modal (existing `sillyErrors.ts` pattern). Destructive cascading deletes require a live connection. No ambiguity.

5. **Error handling convention (added to CLAUDE.md):** Never silently swallow errors. Every mutation must surface failure to the user — either inline error UI or the global ErrorNotifier. No empty catch blocks, no console.error-only handling. The 8 existing silent-swallow mutations will be fixed in Phase 1.

## Open Questions (remaining)

1. **Staleness threshold** — How old can cached trip data be before we warn the user? 5 minutes? 30 minutes? 1 hour? This affects the "Last synced" indicator behavior. (Can decide during Phase 5 implementation.)
