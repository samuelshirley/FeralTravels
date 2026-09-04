# Claude Code prompt — item 13: per-user paywall enforcement, so the wall can be tested while it stays off for everyone

**Why this is needed, in one paragraph.** Enforcement is a single global row —
`app_meta.paywall_enabled`, read by `paywallEnabled()` in `src/server/payments/switch.ts`. When it
is off, `applySwitch` (`src/server/payments/entitlements.ts:19-28`) rewrites *every* verdict to
`entitled: true, enforced: false, blockReason: null`, so no paywall UI exists anywhere — web, iOS,
or Penny — even though the account state machine still correctly reports `trial_expired`. I need
it to stay **off** for at least another week: the web app is what I am demoing to job applications
while the iOS build works its way to the App Store. But I also need to prove the wall actually
works before I turn it on for real, and there is currently no way to have both.

So: **an enforcement override on a single account.** Global switch stays off; the accounts I name
get walled exactly as if it were on.

## What exists already — do not rebuild any of it

- `scripts/make-test-user.ts` (`npm run test-user`, `-- --days 0`, `-- --no-trip`) mints disposable
  paywall test accounts of a chosen trial age, through the same `createTestAccount` the admin panel
  uses, against whatever `DATABASE_URL` points at.
- `/admin` has `TestUserBlock` and `PromoCodeBlock` for exactly this workflow.
- `users.comped` (`src/server/db/schema.ts:71`) is the precedent for what I am asking for, in the
  opposite direction: a per-user boolean that makes the paywall not apply. Mirror its shape,
  including the comment explaining what it is for.
- `scripts/set-paywall-flag.mjs` flips the global row.

## The change

**Column.** A new migration adding `users.paywall_enforced boolean not null default false` —
"enforce the paywall on this account even when the global switch is off". Default false means an
existing row cannot start enforcing anything, which is the same fail-safe direction the rest of
this subsystem takes.

**Wiring.** `getAccountVerdict` (`entitlements.ts:37`) already selects `comped` from `users`; add
the new column to that same select so this costs no extra query. Then `applySwitch` needs to know
the user — today it takes only the verdict. Pass the flag in, and enforce when
`await paywallEnabled() || forcedForThisUser`.

**Precedence, and this is the part to get right:** `comped` beats the override. A comped account is
entitled by `resolveAccountState` before `applySwitch` is ever consulted, so forcing enforcement on
one changes nothing. Do not "fix" that by having the override defeat `comped` — comped is the
author account and the E2E fixtures, and E2E going paywalled because someone set a flag is a bad
trade. Instead make it impossible to be confused by: if both are set on one account, the admin UI
must say plainly that comped wins and the override is doing nothing.

**Fail direction.** If the flag cannot be read, do not enforce. Same asymmetry `paywallEnabled()`
documents at length: wrongly answering "on" walls someone who should not be walled and the recovery
is another database read; wrongly answering "off" costs a few free Penny turns.

**Admin control.** A per-account toggle in `TestUserBlock`, beside the existing test-account tools.
Write a `usage_events` row when it flips, the way `/api/admin/paywall` does for the global switch —
"who forced this account into the paywall, and when" is the question that gets asked the first time
somebody is blocked unexpectedly. A `--user <email> --on|--off` flag on `scripts/set-paywall-flag.mjs`
(or its own small script) so it can be done without a browser.

## What this does and does not prove

Say this in the admin copy, because it is the thing most likely to be misread later. The override
proves **the gate**: that an expired account sees the wall, on web and in the app, that
`canViewExistingTrips` behaves, that `PlanRequiredOverlay` and the paywall bubble render, that
Penny refuses. It does **not** prove **the transaction** — StoreKit/RevenueCat purchase flow needs
a sandbox Apple ID on a TestFlight build, and that is a separate axis I test separately. A wall
that appears is not a wall you can pay your way past.

## While you are here — three more comments that lie

The switch moved out of the environment on 2026-09-02 (`switch.ts:18-31`), but the admin panel
still tells the reader to set the old env var:

- `src/app/admin/TestUserBlock.tsx:69`, `:74` and `:209` — `PAYWALL_ENABLED` / "set
  `PAYWALL_ENABLED=1` on this deployment"
- `src/app/admin/PromoCodeBlock.tsx:140` and `:159` — same

All five should point at the `app_meta` switch and the `/admin` toggle, and `:209` and `:159`
should point at the new per-user override, since that is now the right answer to "why am I not
seeing a wall". Update `CLAUDE.md` if it still describes the env var too.

## Tests

- The pure rule: global off + override on → enforced; global off + override off → not enforced;
  global on → enforced regardless; comped + override → entitled, and a test that says so on
  purpose so nobody later "fixes" it.
- An end-to-end pass on a `npm run test-user -- --days 8` account with the override on, against a
  preview: the wall renders, an existing trip behaves per `canViewExistingTrips`, Penny refuses.
- Mutation-check each one.
- Prove the blast radius with a test: a second, un-flagged account on the same deployment stays
  completely unwalled while the first is blocked. That is the property the whole feature exists
  for, and it is the one I would be embarrassed to get wrong in front of an interviewer.

## Report back

Confirm the global switch is still off in prod after your change, and tell me the exact command to
turn the override on and off for one email.
