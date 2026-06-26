# Penny — capturing the comfortable & max driving range

**Status:** Design (supersedes the proposed brief `penny-comfortable-range-task.md`)
**Date:** 2026-06-26
**Scope:** Penny + onboarding only. Finn (fuel pricing / stop-finding) is a separate agent/task and consumes the numbers produced here — he never derives them.

> **One sentence:** Penny's job is to capture **two validated machine numbers — the driver's *comfortable* driving range and their *hard-max* driving range between fills (km, stored)** — keep them current, and hand them to Finn. Finn does all fuel math; Penny does the conversation that produces his inputs.

---

## 1. What changed from the earlier brief

The uploaded brief got the spirit right but is **stale or wrong on three specifics**, verified against the live code:

1. **The "double-reserve" bug is already gone.** The brief says `computeEffectiveRangeKm(refill_distance_km)` "shaves a further ~20% off." It does not. Post-migration-0007 the function is the **identity** (`src/lib/penny/context.ts:168` — rounds, guards non-positive, returns the number as-is). The old fuel-economy/tank/20%-buffer computation was already collapsed into the single user-stated number. **There is nothing to retire here.** The only remaining fraction is `SAMPLE_FRACTION = 0.85` in `src/server/fuel.ts` — a *stop-spacing sampling cadence* (plan a fill roughly every `range × 0.85`), **not** a reserve on the range. That belongs to fuel planning (Finn's side), not to the stored number.

2. **This is not a new field, and not a new table.** `vehicles.refill_distance_km` (`schema.ts:160`) already *is* the comfortable-range number. Reframe it; don't invent a `comfortable_fuel_range` table. We **do** add one new column for the hard-max (see §3).

3. **"Never null / never fall back" is too absolute** and contradicts how the codebase already (correctly) works. See §6 for the precise invariant.

---

## 2. The two numbers (and the third we don't store)

The driver lives somewhere between "I'd like to fill up around here" and "I will absolutely not go past here." We capture both ends of that, because trusting only the comfortable number throws away the safety ceiling, and trusting only the max nags the driver too late.

| # | Name | Column | Meaning | Who uses it |
|---|------|--------|---------|-------------|
| 1 | **Comfortable range** | `refill_distance_km` (exists) | How far the driver is *happy* to go before refuelling. The everyday planning target. Sam's Hilux: **500 km**. | Finn plans fills around this. |
| 2 | **Hard-max range** | `max_refill_distance_km` (**new**) | The furthest the driver will *ever* be routed before a forced fill — the line Finn must **never** cross. Sam's Hilux: ~**550 km**. | Finn's hard ceiling. Never exceeded, for any price. |
| 3 | *Technical dry-tank range* | — (not stored) | What the vehicle *can* physically do running to empty (~650 km). | Nobody. It's a trap — it has no reserve baked in. |

**Why both.** The "I'd stretch to 550 for significantly cheaper fuel" behaviour Sam described is **not a third Penny number** — it's Finn's pricing *policy*, exercised in the window `[comfortable, max]`. Penny supplies the window; Finn decides where inside it to stop based on price. This is the clean seam: Penny never reasons about price, Finn never invents range.

**Reserve is already baked in.** Both numbers are the human's *lived-in* figures — the driver has already mentally subtracted their own cushion. Finn must use them **as-is** and subtract only `kmBurnedSinceLastRefuel`. No second haircut (and per §1, there is none today — keep it that way).

---

## 3. Storage & the hard-max default

- `refill_distance_km` — keep. Reframe its question wording (§4).
- `max_refill_distance_km` — **new nullable integer column on `vehicles`.**

**Constraints (server-enforced, every save):**

```
FUEL_STOP_SPACING_KM_MIN (200) ≤ comfortable ≤ max ≤ FUEL_STOP_SPACING_KM_MAX (1500)
```

i.e. both within product bounds, and **comfortable ≤ max** (a max below comfortable is incoherent and rejected with a re-ask).

**The one safe default.** If the driver gives a comfortable number but no separate max, **default `max := comfortable`**. This is the *only* fallback permitted in this flow, and it's safe because it's the **conservative** direction: max = comfortable means "Finn never stretches past comfortable," which cannot strand anyone. It must be stated to the user ("I'll never route you past 500 km unless you tell me you'll stretch"), never silent. Contrast with §6: we never *default the comfortable number*, because no value there is safe.

> **Decision for Sam:** make the hard-max question **optional with this safe default**, so onboarding stays effectively one mandatory question (you liked "if they give a number, move on"). The max is captured when offered, and conservatively assumed when not. Flag if you'd rather force both.

---

## 4. The onboarding conversation

### Q1 — Comfortable range (required)

> *"What's your comfortable driving range on a tank — how far you're happy to drive before you'd want to refuel? Not the absolute max your vehicle can do; the distance where you'd naturally start looking for fuel."*

- Example offered for calibration: *"e.g. a lot of drivers with a ~650 km tank are comfortable to about 500 and plan fills around there."*
- **If they give a number in bounds → store it, move to Q2. Done. No further interrogation** — this matches your instinct.
- If out of bounds (or junk) → re-ask with the bound stated. Never store junk, never guess.

### Q2 — Hard-max range (optional; safe default = comfortable)

> *"And the furthest you'd ever let me push it in a pinch — the line I should never route you past? (Leave blank and I'll just never send you beyond your comfortable range.)"*

- Number ≥ comfortable and ≤ 1500 → store.
- Blank → `max := comfortable`, stated back.
- `< comfortable` → re-ask ("that's shorter than your comfortable range — the max should be the same or further").

### The "I don't know" branch on Q1 — the hard part

Some drivers won't know their range as a number. This is where it gets risky, and where your "we never want someone to run out of gas" rule bites hardest. **Deriving a safety-critical range from a make/model string is guessing**, and guessing is exactly what the lockdown exists to prevent. So the branch is designed to **help the driver arrive at a number they confirm — never to silently author one.**

Two sub-paths, in order of preference:

**(a) Deterministic — tank + economy (preferred).** Ask two things the driver can usually find on the dash / fuel app:

> *"No problem — roughly how big is your tank (litres or gallons), and about how far do you get per tank or per litre/gallon?"*

Compute `usable_range ≈ tank × economy`, then propose a comfortable figure (e.g. ~80% of that) **for the driver to confirm or edit**. The math is deterministic; the LLM is not involved. The driver owns the final number.

**(b) Make/model estimate (fallback, LLM, propose-only).** If they don't know tank/economy either, ask make + model + year:

> *"Tell me the make, model and year and I'll suggest a starting figure you can adjust."*

A forced-tool Anthropic call (the `parseStartDate` pattern — `tool_choice` pins one schema returning `{ comfortable_km, max_km }`) **estimates** a conservative range. Then — and this is non-negotiable — **the estimate is shown to the driver for confirmation, flagged as an estimate, never persisted until confirmed.** Server re-validates bounds. This is the weakest path (the model *estimates* rather than *converts*), so it is the last resort and is always surfaced as "assumed," exactly like a vague trip date.

> **Recommendation:** ship **Q1 + Q2 with re-ask** first (the whole MVP value), and add the "I don't know" derivation as a fast-follow. The derivation is the part most likely to leak scope and the part with real data-quality risk; don't let it block the core capture.

---

## 5. "Is onboarding pure code or the LLM?" — you asked, here's the answer

You're **mostly right, with one correction.** Onboarding orchestration (`src/server/onboarding.ts`) is a **deterministic form-in-chat** — it runs before any general Penny LLM turn, walks a fixed question list, validates, persists. That part is pure code and should stay that way.

But it is **not** true that onboarding never touches the LLM. It already calls the model at **exactly one boundary**: `parseStartDate.ts` turns free-text dates into an ISO date via a **forced tool** (`tool_choice`), then re-validates server-side before storing. The principle (from `CLAUDE.md`): *the LLM converts, it does not author* — it can only hand back the pre-declared shape, and the server re-checks it.

So the correct mental model for range capture:

- **Number answers → no LLM.** A typed number is coerced deterministically (today's behaviour via `coerceVehicleProfileValue`). Cheaper, faster, zero hallucination. Keep it.
- **Make/model estimate → LLM, but propose-only.** The one spot an LLM helps, and even there it *estimates and proposes*, the human confirms, the server validates. It does not write the number to the DB on its own.

Nothing about this requires re-architecting onboarding. It's the same deterministic-form + single-forced-tool-boundary shape that already exists for dates.

---

## 6. Lockdown invariants (the validation rules you asked to pin down)

Restating your "never null / never fall back" correctly, because as written it's too strong and the date flow already (rightly) violates the literal version:

1. **Never silently fall back.** Any assumed/default value (e.g. `max := comfortable`) is **stated to the user**, never quietly stored.
2. **Never persist a guessed or hallucinated value.** An LLM-estimated range (make/model path) is *proposed*, shown, confirmed, and bound-validated server-side before it touches the DB. The model can only return the declared `{comfortable_km, max_km}` schema; the server re-validates.
3. **The comfortable number has no fallback default.** Unlike a trip date (where "start today" is always a *valid* date), there is **no safe default range** — too low nags, too high strands. So the comfortable number is **re-asked until valid**, never defaulted.
4. **The hard-max has exactly one safe default:** `max := comfortable` (the conservative direction; cannot strand anyone), and it's surfaced. That is the *only* permitted fallback in this flow.
5. **Bounds are enforced server-side on every save:** `200 ≤ comfortable ≤ max ≤ 1500`. Reuse `FUEL_STOP_SPACING_KM_MIN/MAX` and add the `comfortable ≤ max` check.
6. **Null means "not yet onboarded," and nothing else.** A vehicle mid-onboarding may have null range columns. A vehicle that has *completed* the range step must have non-null, in-bounds, `comfortable ≤ max` values. Remediation (`storedVehicleProfileFieldNeedsRemediationRepair`) must treat a null/out-of-bounds `max_refill_distance_km` the same way it treats `refill_distance_km` today — re-ask, don't paper over.
7. **No double-derate.** The stored numbers are usable as-is; Finn subtracts only burned km. (Already true — keep it; see §1.)

---

## 7. The seam to Finn

Penny hands Finn two validated integers and stops:

```
comfortable_range_km : int   // refill_distance_km  — plan fills around this
hard_max_range_km    : int   // max_refill_distance_km — NEVER route a dry stretch past this
```

Finn's contract (his task, not this one):

- Plan fills targeting `comfortable_range_km`.
- May stretch toward `hard_max_range_km` to reach materially cheaper fuel — **never beyond it, for any price.**
- **Do not re-apply a reserve haircut** to `comfortable_range_km`. Note the existing `SAMPLE_FRACTION = 0.85` in `src/server/fuel.ts` already samples *within* the range; if that planner is reused, confirm it isn't double-conservatively derating an already-comfortable number. (Flagged for Finn's task, not fixed here.)

Penny owns nothing past the handoff: no stations, no prices, no ranking.

---

## 8. Out of scope (explicitly)

- **Fuel type** (diesel/petrol/LPG/AdBlue) for station matching — the old brief wanted to re-add it. It's a Finn input, not part of "the number," and you scoped this chat to the range numbers. Tracked separately; not in this doc's slice.
- Live mid-trip editing of the numbers, GPS reconciliation, tank-state override — real, but post the core capture. Worth their own doc.
- Anything Finn: pricing, stop-finding, gap alarms, region price feeds.

---

## 9. Action items (Penny only)

1. [ ] Add nullable `max_refill_distance_km` integer column to `vehicles` (`schema.ts` → `db:generate` → `db:migrate`).
2. [ ] Reframe the `refill_distance_km` onboarding question wording (§4 Q1) in `buildVehicleProfileQuestions`.
3. [ ] Add the Q2 hard-max question (optional, safe-default `max := comfortable`, `comfortable ≤ max` validation).
4. [ ] Extend `coerceVehicleProfileValue` / `validateVehicleProfileDraftForSave` and remediation checks to cover `max_refill_distance_km` and the `comfortable ≤ max` invariant.
5. [ ] Expose both numbers in the Penny trip context (`projectVehicle` in `context.ts`) so the handoff to Finn carries both.
6. [ ] *(Fast-follow)* "I don't know" derivation branch — deterministic tank+economy first; make/model LLM estimate (propose-only, forced tool, confirm-before-persist) second.

> **Open decisions for Sam:** (a) hard-max optional-with-safe-default vs. forced? (recommend optional) (b) ship Q1+Q2 first and defer the "I don't know" branch? (recommend yes) (c) column name `max_refill_distance_km` ok, or prefer `hard_max_range_km`?
