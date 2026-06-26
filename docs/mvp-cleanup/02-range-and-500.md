# 02 — Range question reword + onboarding 500 fix

**Size:** Small · **Risk:** Low

Two real fixes plus three verifications of things that already exist.

## A. Fix the onboarding 500 on the hard-max step (real bug)

Repro: the "squirrel" 500 fires on the **onboarding** endpoint with payload `{questionKey: "hard_max_range_km", value: 550}`.

- The replan path catches range-order errors gracefully (returns 400/`failedActions`, no 500).
- The **onboarding** path **throws** the validation error: `src/server/onboarding.ts:864-889`, throw at ~886 (`"That's shorter than your comfortable range — the max should be the same distance or further."`). That throw appears to escape `submitAnswer()` → 500.

**Fix:** in onboarding, treat "hard_max < comfortable" as a **validation re-prompt** (return the message as a `note` / keep the step active), not a thrown error. Mirror how other onboarding validation surfaces inline.

**Unresolved — reproduce during impl:** the report was 550 with a 400 comfortable, where 550 > 400 should *pass*. Either comfortable was higher in that session, or there's a unit/conversion mismatch in the comparison (`miToKm` path, `onboarding.ts:864-873`). Reproduce both metric and imperial before calling it fixed.

## B. Reword the hard-max question (copy)

Current: `src/lib/vehicleProfile.ts:264` — `"And the furthest you'd ever let me push it in a pinch, in ${distLabel}?"`. Out of context; no fuel framing.

**New copy (Sam):** something like *"What's your hard max fuel range? This is the absolute furthest I'll ever route you on one tank for my fuel calculations, in ${distLabel}."* Update the `help` text to match. Keep it required-optional as-is (optional, defaults to comfortable).

This helps both new users (now self-explanatory) and returning users (who were confused seeing a new question with no fuel context).

## C. Verify (already built — confirm, don't rebuild)

1. **Settings exposes both range inputs** — `src/components/VehicleProfileSection.tsx:277-290` (comfortable) + `291-304` (hard-max), both unit-aware. Confirm they actually render on the live Settings page; if not, find why they're hidden.
2. **Returning-user backfill** — `drizzle/0011_add_hard_max_rename_comfortable.sql` already set `hard_max = comfortable` for onboarded users. Confirm in DB.
3. **Units in the question** — `vehicleProfile.ts:229` sets `distLabel` from units; both range questions interpolate it. Confirm the displayed min/max bounds also convert (they should, `229-235`).

## Done when
- Entering hard-max < comfortable re-prompts instead of 500ing (metric + imperial).
- Reworded copy live.
- Settings both-inputs confirmed rendering.
- `npm run test` + `tsc --noEmit` pass.
