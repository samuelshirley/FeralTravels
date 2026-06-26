# 01 — Onboarding teardown

**Size:** Small · **Risk:** Low · **Blocks:** 03 (intent scan should target the trimmed question set)

Cut three onboarding branches that are out of MVP scope. Per CLAUDE.md the DB columns can stay dormant; this removes the *questions, logic, and projections* that consume them.

## A. Remove travel-style (and bake the day-split default)

This is the load-bearing one — don't just delete it.

- Question: `src/lib/vehicleProfile.ts:274-282` (`travel_style`, options at 16-36).
- Consumed: `src/server/onboarding.ts:895-901` calls `deriveFromTravelStyle()` → sets `cruise_max_drive_hours`, `transit_max_drive_hours`, **`max_drive_hours_per_day`**.
- Also derived in the replan dispatcher when Penny sets travel_style: `src/app/api/trip/replan/route.ts` (`update_vehicle` case).

**The catch:** `max_drive_hours_per_day` drives how the day-by-day plan splits legs. Removing travel-style removes its only source.

**Fix:** introduce `DEFAULT_MAX_DRIVE_HOURS_PER_DAY = 8` (constant in `vehicleProfile.ts`). Wherever the day-model / `schedule.ts` / `planSummary.ts` reads `max_drive_hours_per_day`, fall back to the constant when null. Stop writing travel-style-derived values. Remove the `travel_style` field from the `update_vehicle` Penny tool (`src/lib/penny/tools/updateVehicle.ts`) and from `projectVehicle` (`src/lib/penny/context.ts`).

**Verify:** a fresh trip with no travel-style produces day splits capped at ~8h (no more 9.6h Bergen→Trondheim days on the first build).

## B. Remove max-consecutive-driving-days + rest-day derivation

- Questions: `vehicleProfile.ts:284-291` (`max_consecutive_drive_days`) and `293-302` (`rest_days_after_driving`).
- Logic: `onboarding.ts:906-914` derives `max_drive_hours_per_week`.
- Remove both questions and the derivation. Drop `max_consecutive_drive_days` / `rest_days_after_driving` / `max_drive_hours_per_week` from the `update_vehicle` tool + `projectVehicle`.

**Keep:** explicit rest days that come from user intent ("2 days in Bergen"). Those are materialized by `schedule.ts` from leg data, not from the consecutive-day logic — confirm `schedule.ts` doesn't hard-depend on `max_consecutive_drive_days` for rest insertion; if it does, neutralize that path so it only honors explicit stays.

## C. Remove dump-station + water-stop tracking entirely

- Caravan gate: `vehicleProfile.ts:321-322`; interval question `304-311`.
- Gate handling: `onboarding.ts:785-802`.
- Projection: `dump_station_*` in `src/lib/penny/context.ts` `projectVehicle`.
- Columns `dump_station_tracking_enabled` / `dump_station_interval_days` and the `dump_station` stop type are already noted dormant in CLAUDE.md — leave the columns, remove the questions/logic/projection. Remove any dump-station UI in Settings (`VehicleProfileSection.tsx`).

## Done when
- New-user onboarding no longer asks travel-style, consecutive-days, rest-days, or dump-station.
- Day splits use the 8h default.
- `npm run test` + `tsc --noEmit` pass; update onboarding e2e specs (`e2e/onboarding-flow`, `onboarding-validation`) for the shorter flow.
- Update CLAUDE.md (onboarding question list, dormant-column note).
