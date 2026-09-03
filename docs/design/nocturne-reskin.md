# Handoff: Feral Travels — Nocturne reskin + onboarding rework

## Overview

Two things ship together:

1. **A visual reskin** of the whole app to the Nocturne theme (dark blue-grey ground, one blurple accent, Inter, compact spacing, Phosphor icons, outlined actions).
2. **A rework of the trip-plan screen and the pre-LLM onboarding flow** — same information, far less chrome; the 76-word greeting becomes 15 words plus tappable prompts, and the five deterministic onboarding questions become four tap-through steps.

Nothing in the data model, API surface or Penny/Finn logic changes. Onboarding keeps the same states and the same question keys; only presentation and prompt affordances change.

## About the design files

`Trip Plan.dc.html` in this bundle is a **design reference built in HTML** — a prototype of the intended look and behaviour, not production code to copy. The task is to recreate these screens in the existing codebase (Next.js 14 + CSS Modules on web, Expo / React Native in `mobile/`) using its established patterns: `--tp-*` custom properties on web, `lib/theme.ts` + `lib/typography.ts` on native, `StyleSheet.create` per component.

Open it in a browser. It is laid out as numbered turns, newest first. **Turn 7 is the set to build** — every screen in user-journey order, each labelled *chosen* (the user picked it) or *inferred* (derived from the same rules, no new decisions). Turn 1, at the bottom, is a pixel recreation of the **current** UI, for before/after comparison.

Screen ids referenced throughout this document: `7a` trips landing, `7b`–`7e` onboarding steps 1–4, `7f` trip plan collapsed, `7g` trip plan day expanded, `7h` map, `7i` chat, `7j` settings.

## Fidelity

**High-fidelity.** Colours, type sizes, weights, spacing, radii and copy are all final. Recreate pixel-for-pixel using the codebase's own primitives. Where a value below is a token, use the token — do not hard-code it.

---

## 1. Design tokens — do this first

Most of the reskin is one edit in two mirrored files. Keep them in step; `mobile/lib/theme.ts` documents itself as a character-for-character mirror of the web block.

### Colour

Edit `src/app/layout.tsx` (the `--tp-*` block, ~lines 74–105) and `mobile/lib/theme.ts`:

| Token | Current | New (Nocturne) | Nocturne name |
|---|---|---|---|
| `--tp-bg` | `#F6F2EA` | `#161826` | `--color-bg` |
| `--tp-surface` | `#FFFFFF` | `#232532` | `--color-surface` |
| `--tp-surface-muted` | `#FBF8F3` | `#1f2130` | between bg and surface |
| `--tp-border` | `#E6DFD4` | `#3f424d` | `--color-neutral-800` |
| `--tp-border-strong` | `#D4C9BA` | `#595d6c` | `--color-neutral-700` |
| `--tp-text` | `#333333` | `#e9e9ed` | `--color-text` |
| `--tp-muted` | `#5C5C5C` | `#b2b6ca` | `--color-neutral-400` |
| `--tp-subtle` | `rgba(51,51,51,0.45)` | `#75798c` | `--color-neutral-600` |
| `--tp-primary` | `#4E7AB0` | `#9184d9` | `--color-accent` |
| `--tp-primary-hover` | `#3D6799` | `#b5abfc` | `--color-accent-400` (lighter on a dark ground) |
| `--tp-primary-muted` | `rgba(78,122,176,0.14)` | `rgba(145,132,217,0.14)` | accent @ 14% |
| `--tp-on-primary` | `#FFFFFF` | `#e9e9ed` | never pure white |
| `--tp-gold` (fuel) | `#B8956A` | `#9184d9` | mono palette — fuel is the accent |
| `--tp-success` | `#4A8B7A` | `#9184d9` | mono palette |
| `--tp-danger` | `#C65D4A` | `#cfd3e5` on `#595d6c` border | see decision 4 |
| `--tp-map-chrome` | `#EDE8E0` | `#1f2130` | |
| `--tp-overlay` | `rgba(51,51,51,0.4)` | `rgba(0,0,0,0.55)` | |

Extra ramp steps the designs use (add them; they have no `--tp-*` equivalent today):

```
--tp-neutral-300: #cfd3e5;   --tp-neutral-900: #292b31;   /* hairline */
--tp-accent-300: #d2cefd;    /* accent text on accent tints */
--tp-accent-400: #b5abfc;    --tp-accent-700: #5d5294;    --tp-accent-900: #2b2741;
```

Also in `mobile/lib/theme.ts`: `rest` (base-day green `#6BA368`) → `#9690c9` (`--color-accent-2-500`), the one place a second role is still useful; `splash` stays `#55346F`.

### Elevation

On a dark ground elevation is an edge plus ambient darkness — replace the two shadow tokens:

```
--tp-shadow-sm: 0 0 0 1px #3f424d;
--tp-shadow-md: 0 0 0 1px #595d6c, 0 6px 18px rgba(0,0,0,0.55);
```

Native `shadow` in `mobile/lib/theme.ts`: drop `shadowOpacity` to 0 and express the edge as `borderWidth: 1` / `borderColor` at the call sites that used `shadow.sm` purely for definition; keep `shadow.md` (offset 4, radius 12, opacity 0.55, black) for the map sheet, modals and the account menu.

### Type

`src/app/layout.tsx` loads Onest via `next/font/google`; `mobile/lib/typography.ts` maps weights to `@expo-google-fonts/onest` faces.

- Swap the family to **Inter** (`next/font/google` on web; `@expo-google-fonts/inter` on native, same five weights so `font.*` keys keep working).
- **Cap weight at 600, and use 500 for headings.** Nocturne's rule is "hierarchy is size and space, not weight" — every `font.bold` / `font.extrabold` on a *heading* becomes `font.medium`. Keep 600 for small all-caps kickers, badges and button labels, where it is doing legibility work at 9–11px.
- Numbers in distances, dates and ranges: add `font-variant-numeric: tabular-nums` (`fontVariant: ['tabular-nums']` on native).

### Spacing and radius

Nocturne is 0.7× density. The app's current values are close enough that a global rescale is **not** wanted; instead use this scale for anything new or re-laid-out: `2.8 / 5.6 / 8.4 / 11.2 / 16.8 / 22.4`. Radii: `4` small, `8` default, `14` cards (replace the current `8 / 12 / 16` in `theme.radius*`).

### Icons

Add Phosphor and route every glyph through it.

- Web: `@phosphor-icons/react`.
- Native: `phosphor-react-native`.
- `mobile/components/icons.tsx` currently hand-copies path data from the web SVGs. Replace each export with the Phosphor equivalent so the two platforms share one set: `ListIcon`→`ListDashes`, `MapIcon`→`MapTrifold`, `ChatIcon`→`ChatTeardrop`, `SettingsIcon`→`GearSix`, `ChevronLeftIcon`→`CaretLeft`, `PencilRenameIcon`/`PencilEditTripsIcon`→`PencilSimple`, `TruckIcon`→`Truck`, `PaperclipIcon`→`Paperclip`, `SendArrowIcon`→`ArrowUp`, `AccountIcon`→`User`.
- **Emoji must go.** `mobile/components/StopCard.tsx`'s `STOP_DISPLAY` uses `⛽` and `📍`; use `GasPump` (fill) and `MapPin` (fill). Same for the web's `src/components/stops/StopCard.tsx`. Nav-button `▶` becomes `NavigationArrow`; the chevron `▾` becomes `CaretDown`; `×` remove buttons become `X`; the `⚠` continuity warning becomes `Warning`.
- Bottom nav uses the **fill** weight for the active tab and regular for the rest (this replaces the colour-only active state).

---

## 2. The four decisions the tokens can't carry

1. **Primary buttons become outlined, never filled.** 1px accent border on an 8%-accent tint, accent-300 label. Affects `mobile/components/ui.tsx` `Button` (`variant="primary"`), `VehicleProfileSection` save / `+ Add vehicle`, `StopsSection` `Add` and `Open vehicle setup`, `NewTripButton`, `TripCard`'s clone pill, `LegCard`'s nav buttons, and the web equivalents. `variant="secondary"` stays as-is (neutral outline). Pressed state: `--tp-accent-400` border + 14% tint. Focus (web): `outline: 2px solid var(--tp-primary); outline-offset: 2px`.
2. **Emoji → Phosphor** (see above).
3. **Nested cards flatten.** This is the one structural change: today `Itinerary` wraps legs in a bordered card, `LegCard` draws another surface, and `StopsSection` draws two more (`STOPS`, `PASTE GPS`) with `StopCard`s inside those. Target: one card per day at most, sections inside it separated by hairlines (`1px solid var(--tp-neutral-900)`), stops as rows on a route line rather than cards. See `7g`.
4. **Destructive actions.** Nocturne is mono, so the designs render Delete as a neutral outline (`#cfd3e5` label on a `#595d6c` border) — see `7j`. **Confirm before building:** if you want delete-account and delete-trip to stay red, keep `--tp-danger` at `#C65D4A` and use it for those two only. Everything else that is currently danger-tinted (inline form errors, the fuel-plan failure notice) reads fine in neutrals.

---

## 3. Screens

Common chrome, every screen:

- **Header** (`mobile/components/TripHeader.tsx`, web `AppNavbar`): 62px top inset, `var(--space-6)` horizontal, 1px hairline bottom, no shadow. `CaretLeft` + trip name at 15px/500. Right: vehicle chip (1px neutral-800 pill, `Truck` in accent at 13px, 11px label) and a 28px avatar circle with a 1px neutral-800 border. The breadcrumb `Trips /` prefix is dropped — the caret is the affordance.
- **Bottom nav** (`BottomNav.tsx`): hairline top, `padding-bottom: safe-area`, four equal columns, 20px Phosphor glyph + 9.5px label, fill weight + accent when active. Labels lose their all-caps (`List`, `Map`, `Chat`, `Settings`).
- **Kickers**: 9.5–10px, weight 600, letter-spacing 1.2–1.4px, `--tp-subtle`.
- **Hairline rules that separate major sections** fade at both ends: `background: linear-gradient(90deg, transparent, #3f424d 48px, #3f424d calc(100% - 48px), transparent)` on a 1px div. Inside cards, plain `1px solid #292b31` is right.

### 7a — Trips landing (`app/trips/index.tsx`, `TripCard.tsx`)

Centred `Your trips` header + avatar; then flush-left kicker `YOUR TRIPS` over `Trips` at 26px/500, with an outlined `+ New trip` (36px tall) on the baseline. `EDIT TRIPS` pill unchanged in behaviour, restyled as a neutral outline. Trip card: 14px radius, surface fill, `--tp-shadow-sm`, name 16px/500, meta `16–17 Sep 2026 · 2 days · ~645 km` at 11.5px subtle, `CaretRight` in accent-700. Below a left-fading hairline: an accent dot + `Next: fuel at Reims Ids · in 147 km` (11px) — new, but composed from data the list already loads. Demo/templates section keeps its kicker, a borderless card (hairline only) and both actions (`View →` neutral outline, `Clone to my trips` accent outline). Empty state and clone-overlay copy unchanged.

### 7b — Onboarding 1/4 · `trip_intent`

**Copy change, `src/server/onboarding.ts` (`TRIP_INTENT_QUESTION.label`), 76 words → 15:**

> Where are we going? One city is enough to start — I'll sort the fuel.

Under Penny's bubble, a `TAP TO START, THEN EDIT` kicker and three rows, all of which **prefill the composer and focus it** (reuse `lib/pennyPrefill` / the web's `penny:prefill` CustomEvent — the same channel `+ Add to this day` uses):

1. Accented, 48px, `MapPinSimpleArea` icon — **`Name a city — Lisbon, Girona, Tromsø…`** with a second line `or just start typing`. Prefills nothing; focuses the composer.
2. `Paris to Stuttgart, 5 h days`
3. `Pyrenees loop with 3 rest days`

**No Maps-link row** — that feature gets introduced later, in-trip.

**Composer placeholder is seeded from location:** `{{city}} to …` where `{{city}}` is the device city (accent-300) resolved from the `useDeviceLocation` context + a reverse geocode, with the rest in subtle. Fall back to `Where to?` when location is denied, unavailable or unresolved. Never block the composer on the lookup.

Header shows `1 OF 4` and a 2px progress bar at 25% (accent, soft glow). Both read from the `progress {current, total}` the onboarding snapshot **already returns** and nothing renders today — total is now 4 because name and range merge (see 7e).

### 7c — Onboarding 2/4 · `trip_date`

Penny asks `When are you setting off?` (existing label can shorten to just that; the examples move into the chips and the placeholder). Chip row inside the bubble:

- Accented chip with a `MagicWand` icon = the scanned date, e.g. `Wed 16 Sep` — this is `Question.defaultValue`, already populated by `scanFirstMessage` / `extractDateFromText`. Tapping submits it.
- `Next Saturday`, `In a month`, `Not sure yet` (routes to `TRIP_DATE_CLARIFY_QUESTION` — do not dead-end), `Pick a date` (`CalendarBlank`, native date picker).
- Footnote, only when a date was scanned: `Read "Wed 16 Sep" out of your message — tap to confirm, or say another.`

Composer placeholder: `e.g. November 1st, or 2026-06-03`. The user's answer renders as a right-aligned bubble in a 14%-accent tint.

### 7d — Onboarding 3/4 · `units_pick`

Labels **verbatim from `onboarding.ts:510`** — `Metric (km)` and `Imperial (cheeseburgers)`; the second gets a `Hamburger` glyph on the right. Two stacked 46px radio rows (not a segmented strip — the label is too long to split a 402px screen), selected row = accent border + 8% tint + filled radio dot. Help line beneath: `Only changes what you see — planning always runs in km.`

Answered steps above collapse to one-line receipts: `Check` icon in accent + 11.5px subtle text (`Trip · Lisbon`, `Setting off · Sat 19 Sep 2026`). Do this instead of leaving the full Q&A bubbles in the transcript.

### 7e — Onboarding 4/4 · `vehicle.name` + `range_km`, one card

Merge the two vehicle questions into a single in-transcript form. Penny: `Last thing — what are you driving?`

- `NAME IT` kicker, then a 44px text field (bg = page ground, 1px accent-700 edge, 14px value, `e.g. Duncan` hint right-aligned in neutral-700). This is the only keyboard left in the flow.
- `RANGE ON A TANK` kicker + an `Info` icon carrying the existing help text (`How far you're happy to drive before you'd want to refuel…`) as a tooltip/sheet rather than body copy.
- Range as buttons: `300 km`, `500 km`, `700 km` (42px, neutral outline; selected = accent outline + 8% tint) plus `Other…` (dashed outline → numeric keyboard).
- Link row: `Not sure — work it out from my vehicle` (accent-300, underlined) → the existing `range_help` state. **This path is already built** (`RANGE_HELP_QUESTION`, `estimateRange` in `src/server/parseRangeEstimate.ts`); the estimator's proposal comes back as a confirm card — `FROM "2018 TOYOTA HILUX DIESEL"` / `~700 km on a tank` / `Use it` (accent outline) + `Change` (neutral outline) — instead of another free-text question.
- `Plan my trip` (accent outline, 46px, `ArrowRight`) is the handoff that completes onboarding and fires the first Anthropic call with the stored `pending_intent`. Footnote: `Change either of these any time in Settings.`
- Imperial users: labels and chip values come from `buildVehicleProfileQuestions(units)` as today (`mi` values, `min`/`max` in display units) — the chips are `200 mi / 300 mi / 450 mi`.

*Future feature, not now:* a "search for my vehicle" row above `NAME IT` (make/model lookup → range). It needs a vehicle database and is deliberately out of scope; the card's shape leaves room for exactly one row there.

### 7f — Trip plan, days collapsed (`Itinerary.tsx`)

This is the default landing state. Kicker-free: title at 22px/500 with `PencilSimple` and `ArrowsOutLineVertical` (the icon replacement for `Expand All` / `Collapse All`) as 30px outlined icon buttons on the right; meta line `16–17 Sep · ~645 km · 2 days · 3 fuel` at 11.5px tabular. Then one row per day, separated by hairlines, no card: accent dot for today (hollow ring for later days), `WED 16 SEP` kicker, `PLANNING` status as bare accent-400 text (no badge chrome), title 16px/500, meta `489 km · 4.9 h · 2 fuel stops`, `CaretDown` at the right. Below the list, the next-stop action promoted out of the day card: accent-outlined 46px row, `NEXT STOP` / `Reims Ids · fuel · 147 km` + `NavigationArrow`. `Behind you` / past-day disclosure and the lazy "loading N more legs" footer keep their current behaviour, restyled as hairline rows.

### 7g — Trip plan, day expanded (`LegCard.tsx` + `StopsSection.tsx`)

One card (surface, 14px radius, shadow-sm), everything inside it:

- Header: `WED 16 SEP` accent kicker, `PLANNING` outlined tag, `CaretUp`; title 18px/500; meta `489 km · 4.9 h driving` + `Info` icon. **The driving-time caveat moves into that icon** — the paragraph goes.
- Route timeline, 14px gutter with a 1px connector: `START` (hollow ring) → each `FUEL` stop (accent ring + `GasPump` fill, glow on the next one) → `DESTINATION` (`MapPin` fill). Each row: kicker + name (13.5px), right side = distance in 10.5px tabular (`0 km`, `147 km`, `442 km`, `489 km`), a 30px `NavigationArrow` tap target, and a 26px `X` remove for user-removable stops. This replaces both the three full-width blue buttons and the separate stop cards — the per-row arrow *is* the deep link (`buildSegmentedNavUrls` output, unchanged).
- **The connector is the map's route line, not a hairline**: a 2px `linear-gradient(180deg, var(--tp-primary), #5d5294)` with `box-shadow: 0 0 8px rgba(145,132,217,0.55)`, i.e. the same treatment `7h` paints on the map, so the list and the map read as one route.
- **Navigation is an external hand-off, and must look like it.** Every navigate affordance opens Google Maps via the existing `buildSegmentedNavUrls` / `buildLegDirectionsUrl` URL — so the per-row arrow and the primary action both carry an `ArrowSquareOut` glyph and the action reads `{stop} in Google Maps`, never a bare "Navigate" that implies in-app turn-by-turn.
- One accent-outlined 44px action: `Navigate to {next stop}` — GPS ordering rules unchanged (`orderNavSegments`; GPS decides order, never contents; destination always reachable).
- `Location off — open Settings` becomes an 11px accent-300 row with a `CrosshairSimple` icon. **This needs building, not just restyling:** when the OS permission is denied it must call `Linking.openSettings()` to land the user in the iOS Settings pane for the app; when the app has simply not asked yet, it fires the in-app permission request. `LegCard`'s `enablePath` branch anticipates both paths — wire them and confirm the copy switches between "open Settings" and "tap to turn on" accordingly.
- `PASTE GPS` collapses to a hairline-separated row: `Plus` + `Paste GPS or a Maps link`, expanding to the existing input + Add on tap.
- Keep, restyled to hairline rows: `Planning fuel stops…` spinner, the three fuel notices (vehicle-profile / platform / `no_stations_found`), dismissed-stops disclosure, `ESTIMATED COSTS`, base-day (`leg_type: 'rest'`) variant — base days use `--color-accent-2-500` `#9690c9` where they used green.

### 7h — Map (`TripMap.tsx`)

The map itself: set the native dark style (`react-native-maps` `customMapStyle` / `mapType`, Google dark style JSON on web). App-drawn chrome only: day chips top-left (selected = accent edge, others neutral, on an 90%-opacity surface pill), a 30px recenter button with `CrosshairSimple`, the route as a 1px accent→accent-700 gradient line with a glow, markers as 22px accent-ringed `GasPump` circles / a `MapPin` for the destination / a light dot for live position, and a bottom sheet (14px radius, shadow-md) carrying `NEXT STOP · FUEL`, the stop name, `147 km from start · 342 km to Strasbourg`, then a full-width 44px accent-outlined action on its own row reading `Open {stop} in Google Maps` with an `ArrowSquareOut` glyph — it leaves the app for the deep link, so do not style it as in-app navigation. Keep it on its own row rather than beside the text: at 402px a labelled button and the two-clause meta line cannot share a row without the distances truncating, then a fading hairline and a `List` row summarising the selected day. Marker-tap → list focus behaviour (`focusTarget` nonce) unchanged.

### 7i — Chat (`ChatPanel.tsx`)

Penny identity strip under the header: 34px accent-ringed `P` avatar with a soft glow, `Penny` 14px/500, `Feral Travels AI · plans your days` 11px subtle, and a right-aligned status (`READY` / the pulsing dot for thinking — keep `tp-pulse` timing). Empty state: `START HERE` kicker, a 19px/500 line, and the same tappable prompt rows as onboarding, worded for an existing trip (`"Girona to Lisbon, 5 h days"`, `"I'm in Reims, 150 km in the tank"`, `"Add a rest day in Strasbourg"`). Composer: 46px pill, surface fill, hairline edge, `Paperclip`, `Ask Penny…`, and a 34px accent-outlined circular send with `ArrowUp` (replaces the filled circle). Assistant bubbles = surface + shadow-sm at 14px radius; user bubbles = 14%-accent tint, right-aligned. `PlanSummaryCard`, paywall bubble, queued/thinking indicators and error bubbles keep their structure, restyled with the same tokens.

### 7j — Settings (`app/settings.tsx` + sections)

Cards give way to sections separated by fading hairlines; the `Card` wrapper comes off `UnitsToggle`, identity and vehicle-profile blocks. Order unchanged. `USER` kicker over `Settings` at 26px/500. Units: the segmented strip stays a strip here and keeps **`Imperial (mi)`** — the cheeseburger belongs to the first meeting, not the settings screen — selected segment = 14% accent tint + accent-300 label. Identity: `Signed in as` 11px subtle + the address at 13px, breaking on any character. Vehicle profile: 17px/500 heading + `Penny plans fuel stops around this range.`, then a surface card per vehicle — name 15px/500, `DEFAULT` as an outlined accent tag, `Edit` neutral outline, `REFILL EVERY` (nowrap) + `~300 km` at 16px tabular, and the sole-vehicle hint as 11px neutral-700 body. `+ Add vehicle` is a 42px dashed accent outline. Plan section: `Ambassador plan — ends 2 Mar 2027` + a neutral-outlined `Restore`. Delete account: 12px subtle explainer + a neutral-outlined 38px button with a `Trash` icon (see decision 4). The vehicle **edit form** is not drawn in the designs — build it from the same primitives: 11px labels, hairline-edged inputs on the page ground, accent-outlined Save, ghost Cancel, and the checkbox using an accent fill when checked.

---

## 4. Interactions & behaviour

- **Prompt rows / chips**: tap → prefill composer + focus (never auto-send, so the user can edit). Onboarding answer chips (date, units, range) **do** submit immediately, because they are answers to a specific question, not free text.
- **Progress**: the onboarding header counter and 2px bar read `progress {current, total}` from the snapshot. Total is 4 for a new user (intent, date, units, vehicle) — 3 when units are already set.
- **Receipts**: each answered step collapses to a one-line receipt with a check; tapping a receipt (5b's `PencilSimple` affordance) is optional and can ship later.
- **Transitions**: 200ms ease for chevron rotation and expand/collapse (matches today's `Animated.timing`); progress bar width 240ms ease-out; no new animation elsewhere. Respect reduce-motion as `NewTripButton` already does.
- **States to keep**: fuel syncing pill, `FINDING YOUR LOCATION…`, location-denied branches, `no_stations_found` warning, past-day dimming (0.75), completed-trip badge, clone overlay, queued-message indicator, paywall bubble + `PlanRequiredOverlay`.
- **Touch targets**: nothing below 44px on a primary path — the designs use 44–48px rows for every tappable prompt and answer.

## 5. Assets

- **Inter** via `next/font/google` (web) and `@expo-google-fonts/inter` (native). Weights 400/500/600 are enough after the weight cap; keep 700/800 loaded only if something still needs them.
- **Phosphor Icons** — `@phosphor-icons/react` and `phosphor-react-native`. Regular weight for interface, fill for active nav tabs and map/stop markers.
- No image assets. The map tiles in the prototype are a striped placeholder; the real screen keeps the native map.

## 6. Files in this bundle

- `Trip Plan.dc.html` — the design reference. **Turn 7 is the build set**; turn 1 is the current UI recreated for comparison; turns 2–6 are the exploration and the rejected options, useful for the reasoning behind a choice.
- `ios-frame.jsx`, `support.js` — support files the reference needs to render. Not part of the design.

## 7. Suggested order of work

1. Tokens + type + icon swap (§1) — largest visual win, lowest risk, and it lands on every screen at once.
2. `ui.tsx` / web button primitives → outlined (§2.1) and the emoji swap (§2.2).
3. `7j` settings and `7a` trips landing — pure reskin, no structural change; good verification that the token layer is right.
4. `7f` + `7g` — the flatten. This is the real work.
5. `7b`–`7e` — the onboarding rework, including the two `onboarding.ts` copy changes and the location-seeded placeholder.
6. `7h` map style + sheet, `7i` chat strip and composer.

## 8. Open questions for the designer

1. Delete actions: neutral (as drawn) or keep red? (§2, decision 4)
2. Should `7f` (collapsed) be the *only* list state — i.e. tapping a day opens a full-screen day view rather than expanding `7g` in place?
3. Base days (`leg_type: 'rest'`) currently carry their own green. Confirm `#9690c9` as their colour, or fold them into the one accent and differentiate by icon only.
4. Does the web build need the same open-Settings affordance, or is the browser permission prompt enough there?
