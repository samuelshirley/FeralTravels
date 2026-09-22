# The daily drive-hours cap

> 2026-09-22. How long one driving day may be, where that number lives, and
> why raising it once took five files.

## The rule

A trip's longest driving day is **`tripDriveCapHours(trip)`**
(`src/lib/penny/driveCap.ts`):

- the driver's own `trip_pace` answer (`trips.daily_drive_hours`), when they
  gave one — **in either direction**, shorter or longer than the default;
- else `DEFAULT_MAX_DRIVE_HOURS_PER_DAY` (8, `src/lib/vehicleProfile.ts`).

The answer's band is `DAILY_DRIVE_HOURS_MIN`–`DAILY_DRIVE_HOURS_MAX`, 1–12
(`src/lib/onboardingForm.ts`, mirrored to `mobile/shared/`). The same band
bounds `PATCH /api/trips/[id]`'s `daily_drive_hours`, and the scan that reads
"5 h days" out of an opening message goes through the same
`parseDailyDriveHours`.

Every consumer reads the one function:

| Consumer | What it does with the cap |
|---|---|
| `executeGetRoute` (`src/lib/claude.ts`) | splits a long segment into days of at most the cap; `min_driving_days` for feasibility |
| `add_leg` validator | rejects a drive leg longer than the cap, quoting the trip's number |
| `update_leg` validator | same, for an edit that grows a leg |
| Penny's system prompt | tells her the cap is `context.trip.daily_drive_hours`, the default only when that is null — never a fixed number |

The default stays 8 and stays correct: it is what a trip that never answered
the pace step gets, and `planReady`'s pace line says so out loud when the
number is ours rather than the driver's.

## What it used to be, and why it hid

Until 2026-09-22 the pace step accepted 1–8, and the 8 was enforced in three
more places, each with its own copy:

1. `executeGetRoute` took `Math.min(answer ?? 8, 8)`, so the answer only
   ever made days *shorter*.
2. `add_leg` and `update_leg` compared against the flat constant and ignored
   the trip entirely (`addLeg`'s validator took its context as `_ctx`).
3. The prompt told Penny "~8 hours" as a fixed fact, five times.

Raising the form's bound alone would have produced the worst version of the
bug: the app accepts "12", stores 12, shows 12 on the plan-ready line — and
plans 8-hour days, because get_route clamps and the validators reject
anything longer. Nothing errors; the driver just gets a longer trip than they
asked for and a number on screen that does not explain it.

What made it hard to find is that the ceiling was described as load-bearing
in every comment near it: the form bound said *"8 is the hard cap the planner
keeps anyway"*, the context type said *"the leg validators keep 8h as the hard
ceiling regardless"*, the schema column repeated it, and the tool
descriptions still cited a `vehicle.max_drive_hours_per_day` field that was
deleted with travel style in migration 0014. Each comment was true about its
neighbour and sent the reader to the next one; none of them named a single
owner of the number. `tripDriveCapHours` is that owner now.

## Guards

- `src/lib/penny/tools/addLeg.test.ts`, `updateLeg.test.ts`: a 12h trip
  accepts 12h and rejects 13h, a 4h trip rejects 5h, a trip with no answer
  rejects 9h. Mutation-checked: making `tripDriveCapHours` return the flat
  default fails three of them.
- `src/lib/onboardingForm.test.ts`: `parseDailyDriveHours` accepts 9–12 and
  still rejects 0 and 13.
- `driveTimeMinutesSchema` (`tools/shared.ts`) is a static 24h sanity bound;
  `DAILY_DRIVE_HOURS_MAX` must stay below it.

## The Custom chip

The pace step's server options stay 4 / 6 / 8 h. The web ChatPanel adds a
fourth, **client-only** "Custom" chip that focuses the composer (live on a
`chips` step) and submits nothing. It must not become a server option: a
server option is submitted as the answer, `parseDailyDriveHours('custom')`
is null and would throw the re-ask, and the answered step redraws from
`form_meta.options`, so a fourth option would show up in every answered pace
step. The placeholder names the band (`Hours a day, 1 to 12`), because the
chips stop at 8 and the answer does not. The iOS app has no Custom chip yet;
its composer takes 9–12 all the same.
