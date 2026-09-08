# Claude Code prompt — "Total users" is counting me and the test accounts

Work on **`feat/admin-paywall-per-user`** (pushed, PR open against `main`). Commit there and push.

## The problem

`Total users` on `/admin` is a bare `COUNT(*)` over `users` — `src/server/repos/admin.ts:34` — so
every disposable paywall account and every address of mine is in the headline number. The one
number on that page that is supposed to say how the product is doing is the one number that counts
the developer testing it.

## What to exclude

1. **Test accounts.** There is already a canonical predicate — do not write a second regex.
   `TEST_PURCHASE_EMAIL_PATTERN` and `isTestPurchaseAddress()` in
   `src/server/payments/testPurchase.ts:43-48` (`sam+trial-<tag>@feraltravels.com`). That pattern is
   the security boundary for the whole test-account subsystem, so it is the right definition of
   "not a real user" too.
2. **Anything containing `samuelashirley`**, case-insensitive, any domain, plus-addressing
   included — `samuelashirley@gmail.com`, `samuelashirley+4.9.26.7@gmail.com`, all of it.

## Three things to get right

**Do it once, not three times.** `newUsers24h` and `newUsers7d` (`repos/admin.ts:52-56`) count the
same table with the same problem, and `/settings/page.tsx:243` renders
`Users {totalUsers} +{newUsers7d} (7d)` side by side. Filter one and not the others and the panel
can show more new users this week than users in total. One shared SQL predicate, used by all three,
and a TypeScript predicate that agrees with it for anything counting in JS.

**Null emails.** `users.email` is nullable. `NOT (email ILIKE '%samuelashirley%')` evaluates to NULL
for a null email, and a NULL predicate drops the row — so an account with no email address would
silently vanish from the count. Use `COALESCE(email, '')`, and write a test that a null-email user
is still counted.

**Do not hide them from the user list.** I asked about the count, not the list. `/admin/users` keeps
showing every account, including mine and the test ones — that page is for finding a specific
account, and a filter there would make a real support question unanswerable.

**Say so in the label.** A total that quietly disagrees with the length of the list underneath it
reads as a bug. The stat should name the exclusion in its sub-label, the way the other stats on that
page carry their qualifiers.

## Tests

- A fixture set containing a real user, a `sam+trial-…@feraltravels.com` account, a
  `samuelashirley+anything@gmail.com` account, an uppercase `SamuelAShirley@…` variant, and a
  null-email user: the count is 1 for the real user plus the null-email one, and every excluded
  address is excluded.
- The same fixtures through the 24h and 7d counters, proving the three cannot disagree.
- Mutation-check each: drop one clause from the predicate and watch the matching test go red.
- `tsc --noEmit` and the full suite green before committing. Push to the open PR; do not merge.
