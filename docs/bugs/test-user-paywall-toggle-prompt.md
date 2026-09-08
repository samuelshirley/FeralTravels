# Claude Code prompt — the test-user generator should be able to create an already-walled account

Work on **`feat/admin-paywall-per-user`** (pushed, PR open against `main`). Commit there and push.

## What exists after that PR

- `/admin` header — `data-testid="admin-paywall-switch"` — the deployment-wide switch
  (`app_meta.paywall_enabled`). It stays OFF: the web app is being demoed while iOS is in review.
- `/admin/users/[id]` — `PaywallEnforceControl`, a per-account override (`users.paywall_enforced`)
  that enforces the paywall on one account while the global switch is off.

## The gap

`TestUserBlock` generates the day-7 accounts — `POST /api/admin/test-users` with
`{ action: 'create', ageDays: 7, subscription: null, withTrip }` (`TestUserBlock.tsx:109-124`). It
has no paywall option, so every account it makes lands **unwalled** while the global switch is off,
and the panel then has to warn you about that in a paragraph (`:200-212`). Walking a real wall means
creating the account, leaving the page, finding it under `/admin/users`, and flipping a second
control — three steps to reach the state this block exists to produce.

## What to build

A control in the generator that creates the account with `users.paywall_enforced` already on, so
one press produces an account that is genuinely blocked.

- Add the field to the POST body and to the route's schema, and apply it after creation with
  `setPaywallEnforcedForUser` — the setter is already on the payments surface. Log a
  `usage_events` row the same way `/api/admin/paywall/user` does; a flag set at creation is still a
  flag somebody set.
- **Default it ON.** This block's entire purpose is producing a blocked account, and with the global
  switch off it currently produces the opposite. The comment at `TestUserBlock.tsx:63-79` is an
  afternoon lost to exactly that. Push back in one line if you disagree, but do not quietly default
  it off.
- The "the paywall is switched off in this environment" warning is then wrong for the accounts this
  block makes. Rewrite it so it distinguishes the two: enforcement is off for the deployment, and
  on for this account. Do not delete the warning — it is still true for anything created without the
  option.
- The success panel should say the account is walled and link straight to its `/admin/users/[id]`
  page, so the override can be turned back off without hunting for it.
- `scripts/make-test-user.ts` (`npm run test-user`) goes through the same `createTestAccount` path.
  Give it the matching flag so the CLI and the panel cannot disagree about what a test user is.

## What not to do

- Do not let this reach `comped` accounts. Comped wins over the override anyway, but a generator
  that can set a flag on the author's account or the E2E fixtures is a generator that can turn the
  suite red from the database.
- Do not add a second way to read the enforcement decision. `enforcementApplies` in
  `payments/switch.ts` stays the only rule.

## Tests

- The route applies the flag when asked and leaves it false when not.
- An account created with it has a **non-entitled** verdict while the global switch is off — the
  property the whole feature exists for — and a second account created without it, on the same
  deployment, stays entitled.
- Mutation-check both: drop the flag from the route and watch the first go red.
- `tsc --noEmit` and the full suite green before committing. Push to the open PR; do not merge.
