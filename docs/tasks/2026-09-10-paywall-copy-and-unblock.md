# Paywall: funny suspension copy, and the ability to UNBLOCK

Two changes, plus the reasoning behind them. Read the whole file before
touching anything — the second one has a real design decision in it that is
not yet made, and guessing it wrong writes a lie into the database.

Reproduce before you theorise. `npm test` is 137 files / ~66s, `npx tsc
--noEmit` is clean on main, and the paywall states are all reachable locally
with `npm run test-user` + the admin page. Do not describe a paywall state you
have not actually put an account into.

---

## 1. Make the `revoked` copy funny

Today a suspended account reads like a bank letter:

> **Planning is paused**
> I can't plan on this account any more — if a refund went through, that's
> what follows it. If that looks wrong, tell us and we'll fix it.

The owner wants it to land like Penny having a bad day, in the shape of:

> Penny lost all her balls in the river. This account has been temporarily
> suspended — please contact support.

That is the TONE and the SHAPE, not necessarily the literal line — write the
best version of it. Constraints that are not negotiable:

- **It still has to say the true thing.** "Temporarily suspended" and "contact
  support" must survive whatever joke goes around them. A user who is locked
  out needs to know they are locked out and where to go; a gag that leaves
  that ambiguous is worse than the dry version.
- **Penny is the one talking**, in her own voice, the same as every other
  paywall line. She is the dog-shaped planner, not a support macro.
- **`revoked` ONLY.** The other three block reasons keep their current copy.
  `usage_cap` in particular must stay apologetic and un-funny: it fires when
  OUR costs regressed, and a joke about the user's account at that moment
  reads as blaming them for our bug. `trial_over` and `subscription_over` are
  sales moments and stay as they are.
- **The banned-word sweep still applies.** `src/lib/paywallCopy.test.ts` fails
  the suite on "subscribe"/"subscription"/"subscriber" in anything a user
  reads. The joke does not get an exemption.

Three places say this, and all three must move together or the web, the app
and the API contradict each other:

| Where | File | What it is |
| --- | --- | --- |
| Penny's bubble + the app overlay | `src/server/payments/copy.ts` → `case 'revoked'` | The copy the phone renders; ships without a new binary |
| The web block notice | `src/lib/paywallCopy.ts` → `REVOKED` | eyebrow / heading / body / action |
| The 402 `error` string | `src/server/auth/guards.ts` → `paywallMessage()` | Lands in logs and in any client that ignores `code` |

`mobile/components/PlanRequiredOverlay.tsx` renders the server's copy — its
heading is currently the hardcoded "Planning is paused", so check whether that
heading still fits the new body or whether it should come from the payload
too. Its `FALLBACK` string is for a payload with no copy at all and should
stay plain.

Add a test that pins the new line the way `paywallCopy.test.ts` already pins
the others, and one that pins `usage_cap` as NOT sharing it — the whole point
of `BlockReason` being a separate field is that these four say four different
things, and a future rewrite that collapses them should fail.

---

## 2. The ability to UNBLOCK — this does not exist at all

`/admin/users/[id]` can take access away and cannot give it back. The button
turns into a dead "Access already revoked" and that is the end of the road:

- `POST /api/admin/subscription/revoke` → `revokeSubscription()`
  (`src/server/payments/entitlements.ts`) upserts `status: 'revoked'` with
  `revokedAt` / `revokedBy` / `revokedReason`.
- `resolveAccountState` (`src/server/payments/states.ts`) then returns
  `verdict('revoked', 'revoked', { canView: false })` — the ONE state where
  existing trips also stop being readable.
- There is no route, no repo function and no UI that moves a row out of
  `revoked`.

So a misfire, or a `REFUND` webhook that turns out to have been wrong, is
currently unfixable from the product. That is the bug.

### The decision — MADE, do not relitigate

**Re-activate picks up the old plan.** The owner revokes, then re-activates,
and the account carries on exactly where it left off. It applies to plans that
were ACTIVE when they were revoked — that is the case it exists for.

That has a consequence you must handle, because the current code makes it
impossible:

`revokeSubscription` (`src/server/payments/entitlements.ts`) overwrites
`status` IN PLACE. The moment you revoke, the previous status — `active`,
`grace`, `cancelled`, `expired` — is **gone**. `currentPeriodEnd`, `productId`
and `source` survive, but the status does not, so nothing on the row can tell
you whether re-activating should hand back an active plan or an expired one.
Re-activating everything to `active` would turn the button into a way to mint
free subscriptions out of expired accounts.

So: **record the pre-revoke status on the row, and consume it on re-activate.**

- Add a `pre_revoke_status` column (nullable, same `SubscriptionStatus` union)
  via a `drizzle/` migration. This is a schema change, so the prod-migration
  rules apply — schema out ahead of code, never from a laptop. See
  `docs/` and the prod-outage note about migrating from local.
- `revokeSubscription` writes the current `status` into it before overwriting.
  For a row already revoked, do NOT clobber an existing `pre_revoke_status`
  with `'revoked'` — a double-revoke must not destroy the thing that makes the
  undo possible.
- `reactivateSubscription` restores `status` from `pre_revoke_status`, clears
  it, and clears `revokedAt` / `revokedBy` / `revokedReason` only if you keep
  the audit somewhere else (see below — do not lose the record of the revoke).
- `resolveAccountState` then re-derives everything from the restored status
  plus `currentPeriodEnd` exactly as it does today. Note it already treats the
  clock as the authority: a row restored to `active` whose `currentPeriodEnd`
  has since passed resolves to `expired`, which is correct and is why "picks
  up where they left off" does not accidentally hand back time that ran out
  while the account was revoked.
- A row with no `pre_revoke_status` (revoked before this migration shipped —
  there are such rows in prod today) cannot be re-activated honestly. Refuse
  it with a sentence saying why, rather than guessing a status. Backfilling
  those is a decision for a human with the subscription_events history in
  front of them.

### What to build

- `reactivateSubscription` next to `revokeSubscription`. Same shape as its
  opposite: **requires a typed reason**, records who pressed it and when. A
  control that hands paid access back leaves an audit trail for exactly the
  same reason the one that takes it away does — and the two entries have to be
  readable as a pair months later.
- `POST /api/admin/subscription/reactivate`, mirroring
  `.../revoke/route.ts`: `requireAdmin()`, cookie-only, zod-validated
  `{ userId, reason }` with `.trim().min(1)`, ZodError → 400 with the human
  sentence, everything else → `errorResponse`.
- The UI in `src/app/admin/users/[id]/RevokeAccessControl.tsx`. When the
  account is already revoked, the dead "Access already revoked" button becomes
  a working **Re-activate**. Same reason field, but NOT the same visual weight
  — restoring access is the recoverable direction and should not wear the same
  danger styling as the one that takes a year away. Say in one line what the
  account lands back on (the plan and its period end, both already on the row),
  because "re-activated" is not a state and the admin should see what they just
  handed back before they press it.
- The revoke banner already shows `Revoked <when> by <who> — <reason>`. Show
  the re-activation the same way, so the history reads in order rather than
  the latest action silently replacing the last one. If clearing
  `revokedAt`/`revokedBy`/`revokedReason` is what makes the row consistent,
  the record has to survive in `subscription_events` first — losing the fact
  that a revoke ever happened is worse than a slightly untidy row.
- `subscription_events` — check whether these admin actions are written there
  today. If a revoke is, a re-activation must be too; if neither is, say so rather
  than adding half of it.

### Tests

- Unit, in `states.test.ts`, the three cases that matter:
  1. `active` with term left → revoke → re-activate → entitled again, same
     period end. The happy path the owner asked for.
  2. `expired` → revoke → re-activate → still `expired`, NOT entitled. This is
     the guard against the button becoming a free-subscription generator.
  3. `active` whose period end passed WHILE revoked → re-activate → `expired`.
     The clock stays the authority.
- Unit, on the route: no reason → 400, not 500. Non-admin → refused.
  Re-activating an account that was never revoked → refuse; it is a mistake,
  and a silent no-op hides it. Re-activating a row with no
  `pre_revoke_status` → refuse with the sentence about why.
- E2E in `e2e/subscriptions.spec.ts`: the `refunded` spec already drives an
  account into a closed state and asserts trips are unreadable. Add the round
  trip — revoke via the admin route, assert closed, re-activate, assert the
  trips are readable again, planning works, and `/api/me/entitlement` reports
  the same product and period end it did before the revoke. Assert the
  SERVER's verdict, not just what the page drew; the existing specs are
  careful about that distinction and this one matters more, not less.

Structural guard over detection where you can: the thing that must be
impossible is an admin action that changes entitlement and leaves no row
saying who did it.

---

## Already in the working tree (do not redo)

Two changes from the same session are already applied and green
(`npm test` 137 files, `npx tsc --noEmit` clean):

- **`PurchaseSheet` on desktop** — the plan rows and the App Store button were
  `width: 100%` + padding + border on content-box elements with no universal
  `box-sizing` reset in `globals.css`, so they rendered 26px wider than the
  380px card and poked out of its right edge. Fixed with explicit
  `boxSizing: 'border-box'`; `e2e/subscriptions.spec.ts` now measures that
  nothing inside the card extends past the card.
- **"Choose a plan" is gone from the web sheet**, along with the price rows,
  because the web cannot take the money — the plan is picked in the iPhone
  app, so two unpressable rows were furniture. They still render on the
  allowlisted fake-purchase path, where a row IS pressable. The button is now
  **"Download the app"** (`APP_STORE_CTA_LABEL`), and the promo code field
  moved under it. The prices still travel in `/api/me/entitlement` because
  Penny's bubble quotes them.
- **`Total users` on /admin** counted 38 where 22 were ours. Three anchored
  regexes in `src/lib/internalAccounts.ts`, used two ways: Postgres `~*` in
  `getAdminOverview`, and `RegExp` in the predicate. Count now reads 16.

  **The two halves are tight for opposite reasons, and that is the rule to
  keep.** `feraltravels.com` (and the reserved `.test`) is a wildcard because
  signing up requires receiving a code at the address and we own the mailboxes
  — no stranger can create an account there. `samuelashirley+…@gmail.com` is
  NOT, because Gmail plus-addressing is public: anyone can sign up as
  `+win@gmail.com` and it reaches the owner's inbox, so that pattern matches
  the dated shape only and a `+spam` signup gets COUNTED. Generally: a wildcard
  is safe over a namespace we control, never over one anybody can write into.
  `internalAccounts.test.ts` pins a spam-vector corpus for exactly this, and
  the dashboard prints how many rows were excluded so a pattern that starts
  matching real people moves a visible number.

  Verified against the live database on 2026-09-10: Postgres and the JS
  predicate agreed on all 38 rows, zero disagreements. Mutation-checked both
  guards. The user LIST and the spend tables stay unfiltered — a fixture that
  spent $7 still spent $7.

  Note `sam@feraltravels.com` is now excluded (it is on our domain) while
  `samuelashirley@gmail.com` is still counted — that one is the owner's real
  account, and nobody asked for it to be hidden.
