# Nightly Trip Replan — Feature Spec

> **Status:** Draft
> **Created:** 2026-05-21
> **Context:** Penny should keep trip plans current while users are on the road, recalculating timing from their actual position each night and surfacing constraint violations before they become problems.

---

## 1. Problem

Penny builds a trip plan before departure, but once the user is driving, the plan goes stale. If someone lingers an extra day in Innsbruck or detours through Munich, downstream timing drifts — and hard deadlines ("be in Bad Kissingen by June 3 at 3pm") can silently become impossible. There's no mechanism to detect this, recalculate, or alert the user.

## 2. Overview

A nightly cron job (2am local to the user's GPS position) recalculates active trip plans based on the user's actual location. Most nights this is pure math — no AI tokens. When the user is significantly off-route, it notifies them and offers a Penny-assisted replan.

The system has three layers:

- **Constraint model** — deadlines and preferences stored on legs/stops
- **Replan engine** — deterministic time recalculation + constraint validation
- **Trigger layer** — the nightly cron (and eventually app-open, arrival detection)

---

## 3. Constraint Model

### 3.1 New fields on `legs` table

| Field                  | Type                                        | Description                                                        |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `constraint_type`      | `'arrive_by' \| 'depart_after' \| 'flexible'` | Hard deadline, hard departure, or soft/no constraint              |
| `constraint_datetime`  | `timestamp with time zone`                  | The actual deadline or earliest departure                          |
| `buffer_minutes`       | `integer` (default: 60)                     | How much slack to build into the calculated departure/arrival time |
| `constraint_note`      | `text`                                      | User-facing context, e.g. "ferry departs at 2pm", "meet friends"  |

### 3.2 Constraint types

**Hard: `arrive_by`**
> "I need to be in Bad Kissingen by June 3 at 3pm"

Penny works backwards: drive time + buffer = latest departure time from previous stop. This propagates upstream. Displayed on the trip card as "Leave by 9:00am to arrive with 1hr buffer."

**Hard: `depart_after`**
> "Ferry doesn't leave until 2pm"

Prevents the plan from scheduling departure before the given time. Less common but useful for ferries, check-in times, border crossings.

**Soft: `flexible`**
> "I want to see Neuschwanstein sometime"

No deadline — Penny slots it in where it fits naturally. No constraint validation needed. Could be a detour on an existing leg or an added rest-day activity.

### 3.3 How constraints surface in the UI

The "leave by" / "arrive by" time on trip day cards is **computed, not stored**. It's derived from:

```
leave_by = constraint_datetime - drive_time_to_destination - buffer_minutes
```

When anything upstream changes (route, position, rest day), the display updates automatically. This is not a static annotation.

### 3.4 Penny tool changes

- **`extractTripIntent`** — parse phrases like "need to be in X by Y" as `arrive_by` constraints, "want to visit X sometime" as `flexible`. Add `constraints[]` to the intent output.
- **`addLeg` / `updateLeg`** — accept optional `constraint_type`, `constraint_datetime`, `buffer_minutes`, `constraint_note` parameters.
- **`checkTripFeasibility`** — validate all intermediate `arrive_by` constraints, not just total trip duration. Return per-constraint pass/fail.

---

## 4. Trip Active Gating

### 4.1 Problem

Running the cron on every trip in the database would burn tokens and API calls on trips that were planned months ago and never started.

### 4.2 Schema changes

**Migrate `startDate` and `endDate` from `text` to `date`** (or `timestamp`). Currently free-text — needs to be machine-readable for comparison.

**Add `trip_status` enum to `trips` table:**

```
'draft' → 'active' → 'paused' → 'completed'
```

- **`draft`** — default on creation. Trip is being planned.
- **`active`** — user is on the trip. Cron runs against this trip.
- **`paused`** — user paused the trip (came home early, taking a break). Cron skips.
- **`completed`** — trip is done. Cron skips.

### 4.3 Automatic transitions

- `draft → active`: when `startDate <= today` and trip has at least one leg
- `active → completed`: when `endDate < today`
- `paused` is manual only (user action)
- Penny could prompt: "Your trip starts tomorrow — ready to go?"

### 4.4 Admin visibility

Add to the existing `/admin` dashboard:

- Active trip count (current)
- Historical active-trip-count over time (from `usageEvents`)
- Log a `usage_event` each time the cron runs: `{ type: 'nightly_replan', active_trip_count: N, replanned: M, off_route: K }`

---

## 5. GPS Position

### 5.1 Storage

Add to `trips` table (or a new `trip_positions` table if you want history):

| Field                  | Type                       | Description                              |
| ---------------------- | -------------------------- | ---------------------------------------- |
| `last_known_lat`       | `double precision`         | Last GPS latitude                        |
| `last_known_lng`       | `double precision`         | Last GPS longitude                       |
| `position_updated_at`  | `timestamp with time zone` | When the GPS fix was recorded            |

### 5.2 How it gets populated

For now: the web app POSTs the user's position to a new `POST /api/trips/[id]/position` endpoint each time they open the trip. The cron uses the most recent fix.

Later (iOS): background location updates push to the same endpoint.

### 5.3 Staleness

If `position_updated_at` is more than 24 hours old, the cron skips GPS-based recalculation and sends a generic "here's your plan for today" email. Don't replan against stale data.

---

## 6. Nightly Cron Logic

### 6.1 Schedule

Runs at 2am local time relative to the user's last known GPS position. Implementation: the cron runs on a fixed UTC schedule (e.g., every 15 minutes) and checks whether it's currently ~2am at each active trip's GPS position. This avoids needing per-user cron schedules.

### 6.2 Flow

```
1. Query all trips WHERE trip_status = 'active'
2. For each trip:
   a. Check if it's ~2am at the user's GPS position (±30min window)
   b. If not, skip (will catch them on next run)
   c. Get last_known_lat/lng and position_updated_at
   d. If position is stale (>24h), send generic email, skip replan
   e. Determine which leg they're on (compare GPS to leg destinations)
   f. Calculate distance from expected position
   g. Branch on threshold (see 6.3)
```

### 6.3 GPS Threshold Bands

**Driving legs — distance from the leg's destination:**

| Band       | Distance     | Action                                                                                         |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------- |
| On track   | ≤ 20 km      | Deterministic replan. Recalculate downstream times. Send morning email.                        |
| Minor drift| 20–100 km    | Deterministic replan from actual position. Same morning email (no nag about deviation).         |
| Off route  | > 100 km     | No automatic replan. Send "you're off route" email with link to Penny replan.                  |

**Rest days — distance from the rest day location:**

| Band       | Distance     | Action                                                                                         |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------- |
| On track   | ≤ 50 km      | No replan needed, they're resting nearby. Send morning email.                                  |
| Off route  | > 50 km      | Send "you're off route" email with link to Penny replan.                                       |

### 6.4 Deterministic replan (Level 1)

No AI tokens. For each remaining leg:

1. Call Google Directions API from current position (or previous leg's destination) to next leg's destination
2. Update `drive_time_minutes` and `distance_km` on the leg
3. For any leg with an `arrive_by` constraint: compute `leave_by = constraint_datetime - drive_time - buffer_minutes`
4. If `leave_by` is in the past or unreasonably tight, flag the constraint as **at risk**
5. Store results, compose email

### 6.5 Off-route notification (Level 2)

No automatic replan. Email says:

> "Hey — we expected you near Innsbruck but it looks like you're closer to Munich. Want Penny to adjust your remaining plan?"
>
> [Adjust my trip →] (link to `/trips/{tripId}?replan=true`)

The deep link opens the trip workspace with the chat panel open. Penny's first message is seeded:

> "I noticed you're in {actual_location} instead of {expected_location}. Want me to rebuild your remaining legs from where you are?"

---

## 7. Morning Email

### 7.1 Content (on-track)

**Subject:** "Day {N}: {origin} → {destination} — {distance_km} km"

**Body:**

- Today's leg summary: origin, destination, distance, estimated drive time
- Google Maps navigation link: `https://www.google.com/maps/dir/?api=1&origin={lat},{lng}&destination={lat},{lng}&waypoints={stops}`
- Any constraint warnings: "Leave by 9:00am to reach Bad Kissingen by 3:00pm with 1hr buffer"
- Planned stops along the way (fuel, rest, points of interest)
- Weather note for destination (stretch goal — skip for v1)

**For rest days:**

**Subject:** "Rest day in {location}"

**Body:**

- Confirmation they're resting today
- Tomorrow's preview: "Tomorrow you'll drive to {destination} ({distance_km} km, ~{hours} hrs)"
- Any nearby suggestions (stretch goal)

### 7.2 Sent via

Resend (already integrated for OTP/magic links). New email template in the existing email infrastructure.

---

## 8. Schema Changes Summary

### Modified tables

**`trips`**
- `startDate`: `text` → `date` (migration required — parse existing free-text values)
- `endDate`: `text` → `date`
- `trip_status`: new enum column `'draft' | 'active' | 'paused' | 'completed'` (default: `'draft'`)
- `last_known_lat`: new `double precision` (nullable)
- `last_known_lng`: new `double precision` (nullable)
- `position_updated_at`: new `timestamp with time zone` (nullable)

**`legs`**
- `constraint_type`: new enum `'arrive_by' | 'depart_after' | 'flexible'` (nullable, default: null)
- `constraint_datetime`: new `timestamp with time zone` (nullable)
- `buffer_minutes`: new `integer` (default: 60)
- `constraint_note`: new `text` (nullable)

### New API routes

- `POST /api/trips/[id]/position` — update GPS position
- `GET /api/admin/active-trips` — active trip count + history for admin dashboard

### New cron endpoint

- `POST /api/cron/nightly-replan` — called by Vercel Cron, secured with `CRON_SECRET`

---

## 9. Open Questions

1. **Date migration** — existing trips have free-text dates like "May 28" or "late May". Do we backfill these to proper dates, or only enforce proper dates going forward? Suggest: backfill where parseable, null out the rest and let users fix them.

2. **Multiple constraints per leg** — can a leg have both an `arrive_by` and a `depart_after`? (e.g., "ferry window is 2-4pm"). If so, the schema should support multiple constraints per leg, possibly a separate `leg_constraints` table.

3. **Constraint propagation direction** — if a downstream `arrive_by` constraint tightens, should it automatically shorten upstream rest days? Or just warn? Suggest: warn only in v1, don't auto-modify rest days.

4. **Google Directions API cost** — each deterministic replan calls Directions once per remaining leg. For a 10-leg trip, that's 10 API calls per night. At $5/1000 requests, a trip costs ~$0.05/night. With 100 active trips, that's $5/night. Acceptable?

5. **Timezone edge cases** — what if the user crosses a timezone boundary during the day? The 2am window is based on last-known position, which should be fine since they're stationary overnight. But worth testing.

6. **Trip status UI** — where does the user see/change trip status? A toggle on the trip page? Automatic with a manual override?

---

## 10. Implementation Order

Suggested build sequence:

1. **Schema changes** — migrate dates, add `trip_status`, add constraint fields to legs, add GPS fields to trips
2. **Trip status logic** — auto-activate/complete based on dates, expose in admin dashboard
3. **GPS position endpoint** — `POST /api/trips/[id]/position`, capture on app open
4. **Constraint model in Penny** — update `extractTripIntent`, `addLeg`, `updateLeg`, `checkTripFeasibility`
5. **Constraint display in UI** — computed "leave by" times on trip day cards
6. **Deterministic replan engine** — the core recalculation logic (testable independently of the cron)
7. **Morning email template** — design and build the Resend template
8. **Nightly cron** — Vercel Cron job that ties it all together
9. **Off-route notification** — the 100km+ email with deep link to Penny replan
10. **Admin dashboard** — active trip metrics and cron run history
