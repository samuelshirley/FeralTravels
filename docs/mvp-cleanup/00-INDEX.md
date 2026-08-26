# MVP cleanup — task breakdown (2026-06-26)

Bug list + scope cuts from the last deploy, grouped into 6 work items. Findings below are from a code investigation, not guesses — file:line refs are in each doc.

## The headline corrections (read these first)

1. **Two separate cost guards got conflated.** The "Continue planning" button is the **16-iteration LLM tool-use cap** (`src/lib/claude.ts:77`) — it fires because Penny serializes ~2 iterations per leg. The eager **Google Places fuel calls** are a *different* client-triggered replenish that runs after her turn. Fixing lazy fuel will NOT fix truncation, and vice-versa. They're docs 04 and 06.
2. **"Finn" isn't broken.** `planFuelStopsForLeg` works. It's being *called* eagerly. Doc 06 fixes the trigger, not the algorithm.
3. *(Superseded 2026-08-25: the comfortable/hard-max pair was collapsed to the single `range_km` — migration 0025.)*
4. **The lazy+cached fuel design in CLAUDE.md is aspirational — not built.** No caching exists anywhere. Doc 06 is net-new, not a regression fix.
5. **Removing travel-style has a hidden dependency:** `max_drive_hours_per_day` (drives the day-split) is *derived* from it. Doc 01 bakes an 8h/day default to replace it.

## Decisions locked (Sam, 2026-06-26)

- ~~Hard-max range question~~ *(removed 2026-08-25 — single range question only; migration 0025 dropped the column)*.
- Day-split default after removing travel-style: **8h/day, don't ask.**
- Truncation: **auto-continue + raise cap + loading UX.**
- Loading UX: **real ~30s dog-fetch video** (Sam to upload).

## The 6 work items

| # | Doc | Size | Depends on |
|---|-----|------|-----------|
| 01 | [Onboarding teardown](01-onboarding-teardown.md) | S | — |
| 02 | ~~Range reword + onboarding 500~~ (doc removed 2026-08-25 with the hard-max question itself) | S | — |
| 03 | [First-message intent scan](03-first-message-intent-scan.md) | L | 01 |
| 04 | [Penny capacity: auto-continue + limits](04-penny-capacity.md) | M | — |
| 05 | [Planning loading UX + dog video](05-loading-ux-video.md) | S/M | 04 (shares the long-wait state) |
| 06 | [Lazy fuel sourcing](06-lazy-fuel-sourcing.md) | L | — |
| 07 | [Stops teardown (reduce stop types)](07-stops-teardown.md) | M | — |

Suggested order: 01 + 02 first (small, shrink surface area), then 06 and 04 in parallel (the two big risk reducers), then 05 (rides on 04), then 03 last (largest new feature).

**07 added later (2026-06-26):** follow-on scope cut — the app is "trip steps + gas stops, nothing else," so the leftover amenity stop types (`food` groceries, `rest` parks) + their finders come out. Spec only; has one decision for Sam (keep `overnight`/`other`?).
