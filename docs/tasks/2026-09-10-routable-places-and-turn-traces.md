# Routable places, honest routing failures, and a turn trace worth reading

Four changes, in dependency order. Section 1 is the bug; 2 is the line that
turned the bug into a bad conversation; 3 is why neither was visible; 4 is a
number the driver is planning against and cannot see.

Read the whole file and CLAUDE.md before touching anything. Section 1 has a
decision already made, with the measurement behind it — do not relitigate it,
and do not "simplify" it into passing `place_id` alone.

**Reproduce before you theorise.** Every claim below was reproduced against
the live Google key on 2026-09-10 and against the production database; the
exact calls are quoted so you can re-run them. `npm test` is ~137 files, `npx
tsc --noEmit` is clean on main. Do not describe a routing behaviour you have
not actually seen an API return.

---

## The incident, so you can check your work against it

Production trip `1635600e-1b3b-4bd6-9449-610ad4cff4b6` (`Test trip`, user
`sam+trial-260910-cfc0@feraltravels.com`). Plan already saved: Austin → Marfa
→ Big Bend NP → Guadalupe Mountains NP → Junction → Austin. The driver then
asked, verbatim:

> Let's extend the trip by two weeks and go to Zion national park for 4 days
> if there are parks on the way there or back we can hit for a day add them in

Penny replied that this was "a real routing issue", that "Google Directions is
not finding a path between these precise park coordinates", that it is "a hard
limit of the app's routing engine", offered to route via Moab instead, and
asked whether to save Zion for a different trip.

`penny_turns` row `5131cdc4-486f-4b9e-b6c6-eb7d1d526651`:

```
modelCalls: 9      toolTrace: 20 × get_route, 6 × resolve_place, 2 × extract_trip_intent
appliedCount: 0    failedCount: 0    cost: $0.0939    model: claude-haiku-4-5-20251001
```

Nothing was written. Twenty routing calls, zero changes, and a paragraph of
invented architecture.

**Two things are true at once and you need both in your head.** The Directions
API really did refuse — `usage_events` for that minute holds 8 rows of
`google-directions success=false: no_results` against 9 successes. And the
trip the driver asked for is trivially feasible. Both of these are our bug,
not the model's:

```
Guadalupe → Zion       1329 km  12.8 h   2 days @8h
Zion → Austin          1933 km  19.0 h   3 days @8h
Guadalupe → Carlsbad Caverns    51 km   0.5 h
Carlsbad → Petrified Forest    770 km   7.8 h
Petrified Forest → Grand Canyon 285 km  2.8 h
Grand Canyon → Zion            158 km   1.9 h
Zion → Bryce Canyon            134 km   1.8 h
Bryce → Mesa Verde             603 km   6.1 h
Mesa Verde → Austin           1509 km  14.7 h
```

~36 h of driving and four extra national parks sitting on the corridor, inside
a fourteen-day extension. She declined a trip with a week of slack in it.

**It is not a Sonnet problem, and PENNY_MODEL is not Sonnet.** `main`
(`d7fca6d`) runs `claude-haiku-4-5-20251001`; the 2026-09-09 swap went Sonnet →
Haiku, and the `usage_events` row above confirms Haiku served this turn. Every
failure below is model-independent: Sonnet would have received the same eight
`ZERO_RESULTS` and the same instruction to ask the user. Do not change the
model, and do not rewrite `claude.ts`'s prompt as a fix for section 1.

---

## 1. The routable identity is thrown away at the `resolve_place → get_route` seam

### What actually breaks

Google's Places centroid for a large park is the *polygon* centroid, which for
Zion sits in roadless backcountry. Directions cannot snap it to a road, so it
returns `ZERO_RESULTS`. Reproduced:

```
destination = 37.2982022,-113.0263005            → ZERO_RESULTS
destination = place_id:ChIJ2fhEiNDqyoAR9VY2qhU6Lnw → OK  1335.1 km  774 min
destination = "Zion National Park" (text)         → OK  1329.0 km  767 min
```

Big Bend's centroid happens to land near a park road, which is why half the
trip planned and half did not — and why this has never been seen before.

`src/lib/google/geocode.ts` **already reads `place_id`** off the Places
response (`toMatch`, line ~145; it is on `GeocodeMatch` at line ~60). It is
then dropped: `executeResolvePlace` in `src/lib/claude.ts` (~1409) builds a
payload of `lat/lng/label/address/name_for_leg/granularity` and never mentions
it, and `get_route`'s schema (`src/lib/penny/tools/getRoute.ts`) has no field
that could carry it. Penny is handed a coordinate she cannot route with and no
way to ask for a better one.

Note the granularity check is NOT the culprit here — Zion classifies as
`precise` (it has no `administrative_area_level` type and falls through
`classifyGranularity`'s POI default). Don't go looking there.

### The decision — MADE

**Pass `place_id` INTO Directions, and harvest the road-snapped coordinate OUT
of the same response.** Not one or the other. Both halves, because they solve
different problems and the second is free.

The reason for the second half: six call sites reach
`getDirectionsAccounted`, and most of them re-route a leg that is already in
the database from its stored `start_lat/lng` and `end_lat/lng` — continuity
repair (`repos/trips.ts` ~1176, ~1399), the replan route (~1247, ~1381),
Finn's geometry (`server/fuel.ts` ~333). A leg row carries no `place_id`. So
plumbing `place_id` only as far as `get_route` fixes the first plan and leaves
every later re-route of a Zion leg failing exactly as before — a bug that would
surface days later, in continuity repair, with no user message to explain it.

Directions already returns the snapped points in
`routes[0].legs[].start_location` / `end_location`, in the response we are
already paying for. **Verified 2026-09-10:** routing Guadalupe → `place_id:`
Zion returns `end_location {37.2336032, -112.8751275}`, and that bare
coordinate then routes on its own in both directions:

```
Guadalupe → 37.2336032,-112.8751275   OK  1335.1 km  12.9 h
37.2336032,-112.8751275 → Austin      OK  1916.0 km  18.7 h
```

So: one Directions call, no extra spend, no new SKU, no migration — and every
coordinate we persist from that point on is one Directions is known to accept.

### What to build

1. **`resolve_place` returns `place_id`.** Add it to the `resolved` payload in
   `executeResolvePlace`, and to the `ambiguous` candidates. Document it in the
   tool description as an opaque routing handle — Penny passes it through
   untouched and must never author, edit or invent one.
2. **`get_route` accepts `origin_place_id` / `destination_place_id`**, both
   optional strings, and optionally a `place_id` on each waypoint. Tool
   description: *"If `resolve_place` gave you a `place_id`, always pass it —
   it routes to the place's real entrance, where a bare coordinate may be an
   unreachable centroid."*
3. **`getDirections` uses it.** `origin` / `destination` become
   `LatLng & { place_id?: string }`; the query parameter is `place_id:<id>`
   when present, else `<lat>,<lng>`. Same for waypoints (`place_id:` is legal
   in the `waypoints` list). **The LRU `cacheKey` must include the place_id** —
   two requests for the same coordinate with and without one are different
   requests and must not share an entry.
4. **`DirectionsResult` gains `start_location` and `end_location`** — the
   snapped `{lat,lng}` from `routes[0].legs[0]` (first leg's start, last leg's
   end, so waypointed routes are right). Free; already in the JSON.
5. **`get_route`'s payload to Penny gains `routable_start` and
   `routable_end`** — those snapped coordinates, rounded like everything else —
   and the tool description tells her to use them as `add_leg`'s
   `start_lat/lng` and `end_lat/lng` **in preference to the coordinates she
   passed in**. `suggested_split` points already come off the polyline and are
   road-snapped by construction; leave them alone.
6. **The `<coordinates>` / routing section of `claude.ts`'s prompt** gets the
   one rule that makes 1–5 hang together: a `place_id` from `resolve_place`
   travels with the place into `get_route`, and the leg is written with the
   `routable_*` coordinates that come back. Keep it short — this is a data-flow
   rule, not a new capability.

### Guards, mutation-checked

- A unit test on the URL builder: place_id present → `destination=place_id:X`;
  absent → `destination=lat,lng`; both origin and destination independently;
  waypoints too. Mutation-check by deleting the place_id branch.
- A cache test: same coordinates, different place_id → two entries, two
  fetches. Mutation-check by removing place_id from `cacheKey` and watching it
  return the wrong route.
- A test that `executeGetRoute`'s payload carries `routable_start`/`_end` taken
  from `end_location` and not echoed from the input.
- A source guard in the same family as `goHereLinksGuard`: `executeResolvePlace`
  must emit `place_id`, and `get_route`'s schema must accept it. This is the
  seam that has now silently dropped a field once.

**Do not add a live-API test for Zion.** It would put a paid third-party call
in the unit suite and would go red the day Google moves a centroid. The
coordinates and expected statuses above are the record; put them in a comment
next to the tests so the next person can re-run them by hand.

---

## 2. The failure message told her to give up

`src/lib/claude.ts` (~1520), verbatim, deployed:

```ts
directions.kind === "no_results"
  ? "Try alternative coordinates or ask the user for a different start/end."
  : "Tell the user this lookup is temporarily unavailable; do not invent the numbers."
```

She did precisely that: offered alternative coordinates (Moab), then asked the
driver to pick. That is the instruction working, not a model going off-script.
It is the wrong instruction — the driver named a real, reachable national park,
and "give us a different destination" is not an answer we are entitled to give.

Rewrite the `no_results` branch so it names the actual remedy, in this order:
retry with the `place_id` if one was resolved and not sent; if there was no
`place_id`, say so and re-resolve; only after a genuine retry has failed may
she raise it with the driver — and then as *this specific point could not be
routed*, never as a claim about the app's routing engine.

**She must never characterise our architecture.** "This is a hard limit of the
app's routing engine — it plans drivable paved roads correctly for most of
North America" is a sentence she had no way to know and which is false. Add
that prohibition where the prompt already forbids her authoring the numbers:
she reports what a tool returned, she does not diagnose the system. Pin it with
an assertion in the prompt-guard family so a rewrite cannot quietly drop it.

While you are in there: this turn made **20 `get_route` calls across 9 model
calls and applied nothing**. Every one of those model calls re-read the
~23,300-token cached prefix, which is where the $0.0939 went. A turn that
finishes with `appliedCount: 0` after more than a handful of failed lookups is
a shape worth noticing — decide whether that belongs here or in section 3's
trace, but do not build a new retry ceiling on top of the existing
`MAX_TOOL_USE_ITERATIONS` / `MAX_AUTO_CONTINUES` without saying why.

---

## 3. Why none of this was visible

Two gaps, both cheap.

### 3a. `get_route`'s Directions calls are unattributed

`executeGetRoute` calls `getDirectionsAccounted(origin, destination, options)`
with **no fourth argument**. `CallerRef` defaults to `{}`, so every row lands
with `trip_id` and `user_id` NULL. `server/fuel.ts:337` gets this right
(`{ userId, tripId: leg.tripId }`) — copy that. Eight failures on this trip were
in the table the whole time and invisible to `/admin/errors`, to
`dump-trip.ts`, and to anyone reading the trip.

Add it to `googleAccountingGuard.test.ts`, which already polices this family:
a call site inside a Penny tool executor must pass a `CallerRef`. Mutation-check
by removing the argument again.

### 3b. There is no record of what was sent

`penny_turns.result_meta` stores tool **names** only:

```json
"toolTrace": [["extract_trip_intent"], ["resolve_place","resolve_place", ...], ...]
```

No tool inputs, no tool results, no system prompt. Investigating this bug meant
re-deriving Penny's coordinates by re-running `resolve_place` by hand and
guessing that they matched. That is the gap the owner asked to close.

Store, per model call, alongside the existing `toolTrace`: each tool's **name,
input, and the result content handed back** (including `is_error`). `result_meta`
is already `jsonb`, so **no migration**. Requirements:

- **Truncate hard and record that you did.** Cap each stored result (a few KB)
  and each turn's whole trace, with an explicit `truncated: true` marker.
  `get_route` already drops the polyline before Penny sees it, so payloads are
  small — but `suggested_split` on a long route is not nothing, and a trace
  that silently loses its tail is worse than one that says it was cut.
- **The system prompt is a hash, not a copy.** It is ~13,800 tokens and
  identical across every call in a turn; storing it per turn is megabytes for
  no information. Store a stable hash of the assembled system prompt plus the
  tool-schema set, so two turns can be compared and a prompt change is visible
  as a hash change. If you want the text recoverable, that is a separate
  question — answer it in the brief, don't quietly ship a copy.
- **Deletion.** `penny_turns` cascades from `users.id` (`penny_turns_user_idx`,
  migration 0024) — verify that, because tool inputs contain the driver's own
  words and place names, and the account-deletion story for
  `usage_events.error_message` exists precisely for this. If the cascade covers
  it, say so in CLAUDE.md; if it does not, fix it here.
- **Retention is already a known gap** for this table (the residual-notes list
  under the Penny-turn-resilience section). Traces make the rows bigger. Do not
  build a sweeper in this task, but state the new size per turn in CLAUDE.md so
  the decision is made on a number.

There is no admin surface for this in scope — `dump-trip.ts` reading the trace
is enough, and extend it to print one.

---

## 4. The daily drive cap is invisible

`trips.daily_drive_hours` is **NULL** on the incident trip, so
`executeGetRoute` capped days at `DEFAULT_MAX_DRIVE_HOURS_PER_DAY = 8`. The
driver has no way to learn that number: the `trip_pace` step
(`server/onboarding.ts:192`) never ran for this trip — the whole wizard was one
question, then handoff — Penny never states it, the plan summary does not carry
it, and Settings shows range only.

Two parts:

1. **Find out why `trip_pace` was skipped.** `onboarding_scan` is NULL on the
   row (cleared at handoff) so the evidence is gone; reproduce it with a fresh
   `npm run trial-account new` and the same opening message — *"Austin to
   Austin, leaving Thu 24 Sept. Happy to take it slowly and stop a few nights
   on the way."* — and read `resolvePostDateState` / the `scanStash` block at
   `onboarding.ts` ~980–1010 against what actually happens. Do not fix a path
   you have not watched execute.
2. **Surface the number wherever the plan is described.** The `plan_ready`
   message (`src/lib/planReady.ts`, mirrored to mobile) is the natural home —
   it is the deterministic, server-authored line, which is exactly right for a
   fact Penny must not author. Say the days are planned at N hours of driving
   and where to change it. Whether it also belongs on the plan summary card and
   in Settings is your call; if you add it to Settings it must be **editable**
   there, because a read-only number the driver cannot change is the complaint
   this section exists to answer, not the fix for it.

The 8 h validator ceiling is unchanged and `range_km` stays Settings-only.
Nothing here gives Penny a tool to write `daily_drive_hours`.

---

## Not in scope

**Do not replay this conversation against Sonnet, and do not touch
`PENNY_MODEL` or `models.test.ts`.** Section 3's trace is what makes that
comparison meaningful, and running it before the trace exists produces another
anecdote. It is the next task, not this one.

**Do not build a routing/feasibility state machine.** It has been floated, and
it would be the wrong response to *this* evidence: the failure is one dropped
field and one line of bad tool feedback, and a new deterministic layer over the
top would leave both in place.

---

## Done means

- `tsc --noEmit` clean, `npm test` green, new guards mutation-checked (say in
  the PR which mutation you ran for each, and what went red).
- The incident is re-walkable: a fresh trial account, the saved Austin loop,
  the same "extend by two weeks, go to Zion" message — and Penny writes the
  legs instead of explaining why she cannot. Say in the PR what the resulting
  plan was and what the turn cost.
- **CLAUDE.md updated in the same commits**, per its own Keeping-this-file-
  current rule. At minimum: the Maps bullet under Stack (place_id in, snapped
  coordinates out, and the Zion centroid as the worked example), the Penny
  Tools section (`resolve_place` returns `place_id`; `get_route` takes one),
  the `penny_turns` section (what a trace holds, the prompt hash, the size),
  the Scripts entry for `dump-trip.ts`, and the daily-drive-hours note.
