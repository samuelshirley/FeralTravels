# Initial Plan Build — Technical Spec

## Overview

When a user sends their first real message to Penny ("Where do you want to go?" → answer), the system should do more than return a conversational reply. It should fire a **"big build"** — a single Penny turn that generates the full skeleton of the trip: legs, route options, fuel stops, water resupply tasks, and overnight spot tasks. This spec covers the end-to-end design.

---

## 1. Trip Creation & Onboarding Flow (current + proposed changes)

### Current state

Trip creation (`POST /api/trips`, `src/server/repos/trips.ts`) creates a bare row with `onboardingState = 'not_started'`. The onboarding form-in-chat (`src/server/onboarding.ts`) then walks the user through vehicle setup via canonical `VEHICLE_QUESTIONS` before setting state to `'done'`.

States today: `not_started → vehicle_pick | vehicle_new → … → ready → done`

### Proposed changes

Add one explicit state between `ready` and `done`:

```
not_started → vehicle_pick | vehicle_new → preferences → initial_plan → done
```

**`initial_plan`** is the state entered the moment the user submits their destination (the handoff question). It's a signal to the backend to fire the big build rather than a normal Penny chat turn.

#### `onboardingState` enum addition (schema.ts)

```typescript
// src/server/db/schema.ts
onboardingState: text('onboarding_state')
  .$type<'not_started' | 'vehicle_pick' | 'vehicle_new' | 'preferences' | 'initial_plan' | 'ready' | 'done'>()
```

#### Vehicle data required for big build

Before the destination question is asked, the vehicle must have:
- `fuelEconomyKmpl` — used to compute range
- `fuelTankL` — used to compute range
- `fuelType` — used to filter fuel stops by type
- `waterRefillDays` — used to schedule water resupply tasks

If any of these are null when `initial_plan` is triggered, the big build degrades gracefully (skips the relevant sub-pipeline and creates a task for the user to fill in the vehicle data).

---

## 2. The "Big Build" — Initial Plan Generation

### Trigger

Detected in `POST /api/trip/replan` (`src/app/api/trip/replan/route.ts`):

```typescript
if (trip.onboarding_state === 'initial_plan') {
  return await runInitialPlanBuild(trip, message, userId);
}
```

The message at this point is the user's destination (e.g. "I want to drive from Cape Town to Nairobi over 6 weeks").

### What it produces (in order)

1. **Legs + routes** — Penny generates legs with sortOrder, start/end coords, distance, drive time, terrain, dates. Each non-trivial leg gets at least 2 route options (via `add_route` actions).
2. **Fuel stops** — For each leg with enough distance, trigger `planFuelStopsForLeg` (already in `src/server/fuel.ts`).
3. **Water resupply tasks** — One or more tasks per leg based on `vehicle.waterRefillDays` and leg duration.
4. **Overnight spot tasks** — One task per overnight stop needed, assigned to the user.

### Penny system prompt additions for initial build

Add a dedicated section to the system prompt (`src/lib/claude.ts`) that activates only for `initial_plan` turns:

```
## Initial Plan Mode
When onboarding_state is "initial_plan", your response MUST:
1. Generate ALL legs for the full trip in a single response.
2. For each leg, generate at least one route (two where meaningful alternatives exist).
3. Set realistic dates: pace at vehicle.max_drive_hours_per_day × average_speed.
4. Do NOT generate fuel stops yourself — emit {"action":"plan_fuel_stops","leg_id":N} 
   for every leg with distanceKm > 100 and the vehicle has fuel data.
5. For overnight stops: emit add_task actions (assigned "user") for each night on the 
   road where no overnight stop is pre-populated.
6. Finish with a "summary" sentence confirming the full plan is ready.
```

### Sequence diagram

```
Client → POST /api/trip/replan (message: destination, tripId)
  Backend detects onboarding_state = 'initial_plan'
  → buildPennyContext (src/lib/penny/context.ts)
  → anthropic.messages.create (big build prompt)
  → parse JSON actions
  → apply add_leg × N
  → apply add_route × M
  → apply plan_fuel_stops × K  →  planFuelStopsForLeg (async, per leg)
  → apply add_task × T
  → set trip.onboarding_state = 'done'
  → return { legs, chatMessage }
```

The fuel stop sub-jobs already run asynchronously (polling via `leg.fuelStatus`). No change needed to that pipeline.

---

## 3. Auto Fuel Stops

### Existing implementation

Already fully implemented in `src/server/fuel.ts`. Key parameters:

| Field | Source | Usage |
|---|---|---|
| `fuelEconomyKmpl` | `vehicles` table | Range calculation |
| `fuelTankL` | `vehicles` table | Range calculation |
| `fuelType` | `vehicles` table | Filter Places results |
| Effective range | `kmpl × tankL × 0.8` | Sample interval |

The pipeline calls `POST https://places.googleapis.com/v1/places:searchNearby` with `includedTypes: ["gas_station"]`, picks the nearest matching station, and inserts `stops` rows with `stopType='fuel'`, `source='google_places'`, `status='option'`.

### Gap: fuel type matching

Current code attempts fuel type matching but falls back silently. Proposed: add a `fuelTypeMatchScore` to the selection heuristic and surface a warning stop when no matching station is found within `SEARCH_RADIUS_KM` (currently 10 km).

### Integration with initial build

The `plan_fuel_stops` action already exists in the Penny action schema. No schema changes needed. The big build emits one `plan_fuel_stops` action per leg; the route handler calls `planFuelStopsForLeg` for each.

---

## 4. Water Resupply Stops

### Data model

No schema changes needed for the stop itself — `stopType='water'` already exists in the `stops` table. But we need the task-assignment concept (see §6).

### Calculation

```typescript
// src/server/water.ts  (new file)
function planWaterResupplyForLeg(leg: LegWithDetails, vehicle: Vehicle): WaterPlan {
  const legDays = Math.ceil(leg.distanceKm / (vehicle.maxDriveHoursPerDay * AVG_SPEED_KMH));
  const refillsNeeded = Math.floor(legDays / vehicle.waterRefillDays);
  // Distribute evenly across leg duration
  return { refillsNeeded, dayOffsets: [...] };
}
```

### Task generation for water

For each required refill point, create two tasks:

**Penny task** — research nearby water sources:
```typescript
{
  title: "Find water refill near [location] (~day N)",
  description: "Research: bore holes, community taps, lodges, national park facilities within 20km of the waypoint. Post a confirmed source with GPS coords.",
  created_by: 'penny',
  assigned_to: 'penny',   // new field — see §6
  leg_id: leg.id,
  priority: 'normal'
}
```

**User task** — confirm and fill:
```typescript
{
  title: "Fill water at [location] (day N)",
  description: "Action: physically refill at the source Penny researched. Mark done once tank is topped up.",
  created_by: 'penny',
  assigned_to: 'user',    // new field — see §6
  leg_id: leg.id,
  priority: 'high'
}
```

The user task is created as `status='open'` and blocked on the Penny task being answered first (new `dependsOnTaskId` FK — see §6).

---

## 5. Overnight Spots

### Problem

Google Places is not useful for overlander-grade overnight spots. `gas_station` works; wild camping spots do not exist in the Places dataset.

### Future integrations (out of scope for initial build)

| Provider | API | Notes |
|---|---|---|
| iOverlander | Public JSON API (`www.ioverlander.com/places.json`) | No auth required, ~50k spots |
| Park4Night | Private API (requires partnership/key) | Best coverage in Europe |
| Caramaps | REST API (`api.caramaps.com`) | French-origin, good EU/Africa |

These were previously in the app and ripped out in commit `c1c8284`. The stop model already has `source='osm'` and `sourceUrl` fields that would accommodate iOverlander/Park4Night records.

### For initial build: task-based approach

For each night on the road (calculated from leg dates + `max_consecutive_drive_days`), Penny emits:

```typescript
{
  action: 'add_task',
  leg_id: N,
  data: {
    title: "Find overnight spot near [estimated_position] (night N)",
    description: "Overlander overnight needed. Check iOverlander, Park4Night, or Caramaps for spots within 20km of [lat,lng]. Alternatives: bush camping, farm stay, national park campsite.",
    created_by: 'penny',
    assigned_to: 'user',
    priority: 'normal'
  }
}
```

The Penny system prompt instructs it to include approximate GPS coords in the description so the user has a search anchor.

### Resuming iOverlander integration (future)

When re-added, the flow would be:
1. `planOvernightSpotsForLeg(leg, vehicle)` — mirrors `planFuelStopsForLeg`
2. Query iOverlander JSON, filter by distance from polyline waypoints
3. Insert `stops` with `stopType='overnight'`, `source='osm'` (or a new `'ioverlander'` source value), `status='option'`
4. Leg gets an `overnightStatus` field analogous to `fuelStatus`

Schema addition needed when re-implementing:
```typescript
// Add to legs table in schema.ts
overnightStatus: text('overnight_status')
  .$type<'not_started' | 'computing' | 'ready' | 'failed'>()
  .default('not_started'),
```

---

## 6. Task System Enhancement: Penny vs User Assignment

### Current model (src/server/db/schema.ts)

```typescript
tasks: {
  created_by: text('created_by').$type<'user' | 'penny'>(),
  // ... no assigned_to field
}
```

The `created_by` field tracks who originated the task but doesn't express who should resolve it.

### Proposed additions

#### Schema changes

```typescript
// src/server/db/schema.ts — tasks table
assignedTo: text('assigned_to')
  .$type<'penny' | 'user'>()
  .default('user'),
dependsOnTaskId: integer('depends_on_task_id')
  .references(() => tasks.id, { onDelete: 'set null' }),
autoResearchStatus: text('auto_research_status')
  .$type<'pending' | 'in_progress' | 'done' | 'failed'>()
  .notNull()
  .default('pending'),
```

#### TypeScript type additions (src/types/trip.ts)

```typescript
export type TaskAssignee = 'penny' | 'user';
export type AutoResearchStatus = 'pending' | 'in_progress' | 'done' | 'failed';

// Add to Task interface:
assigned_to: TaskAssignee;
depends_on_task_id: number | null;
auto_research_status: AutoResearchStatus;
```

### Auto-research pipeline for Penny tasks

When a task has `assigned_to='penny'` and `auto_research_status='pending'`:

1. A background job (or triggered on trip load) picks it up
2. Calls `POST /api/tasks/:id/research` (new route)
3. Route calls Penny with a focused prompt: task title + description + trip context
4. Penny returns an `answer` and optionally a `reference_url`
5. Task updated: `status='answered'`, `auto_research_status='done'`, `answer=...`

This reuses the existing `answer` / `answer_source_url` fields on the task model.

### UI display

- Penny tasks with `auto_research_status='pending'|'in_progress'`: show spinner, "Penny is researching…"
- Penny tasks with `status='answered'`: show answer inline, collapsed by default
- User tasks: show as standard to-dos with checkbox

---

## 7. Data Model Summary — Changes Required

| Table | Change | Reason |
|---|---|---|
| `trips.onboarding_state` | Add `'initial_plan'` value | Detect big-build trigger |
| `tasks.assigned_to` | New column `text`, default `'user'` | Penny vs user split |
| `tasks.depends_on_task_id` | New FK to `tasks.id` | Pair penny research + user action |
| `tasks.auto_research_status` | New column, `'pending'` default | Track Penny research lifecycle |
| `legs.overnight_status` | New column (when iOverlander re-added) | Mirror fuelStatus pattern |

All other needed fields already exist (`stopType`, `source`, `waterRefillDays`, `fuelType`, etc.).

---

## 8. Files Affected

| File | Change |
|---|---|
| `src/server/db/schema.ts` | Add columns above |
| `src/types/trip.ts` | Add `TaskAssignee`, `AutoResearchStatus` types; update `Task` interface |
| `src/server/repos/tasks.ts` | Include new columns in queries |
| `src/server/onboarding.ts` | Add `initial_plan` state transition |
| `src/lib/claude.ts` | Add initial-plan system prompt section; pass `onboardingState` in context |
| `src/lib/penny/context.ts` | Surface `onboardingState` to Penny |
| `src/app/api/trip/replan/route.ts` | Detect `initial_plan`, call big build; set state to `done` after |
| `src/server/fuel.ts` | Already handles `plan_fuel_stops` — no changes |
| `src/server/water.ts` | **New** — water resupply calculation + task generation |
| `src/app/api/tasks/[id]/research/route.ts` | **New** — Penny auto-research endpoint |
| `drizzle/migrations/` | Migration for new columns |

---

## 9. Open Questions

1. **Rate limiting for auto-research**: Each Penny task triggers an Anthropic call. For a trip with 10 legs × 2 water tasks each = 20 Anthropic calls on first plan. Cap per big build? Batch into one call?
2. **Water source verification**: iOverlander has water source tags. Should the Penny research task be skipped when iOverlander data is available and the spot is <2 years old?
3. **Overnight task dedup**: If the user already has an overnight stop selected for a given leg night, don't create a task. Needs date-aware logic.
4. **`dependsOnTaskId` UI**: Does the user task auto-open when Penny answers the research task, or does it need explicit unblocking? 
5. **Task `assigned_to` in Penny JSON**: The `add_task` action schema in `src/lib/claude.ts` needs `assigned_to` added to its description so Penny emits it correctly.
