# Claude Code prompt — the iOS purchase sheet, and the delete-account confirm

Work on **`feat/admin-paywall-per-user`** (already pushed, PR open against `main`). Commit there
and push, so the changes land on that PR.

Reproduce on a device or the simulator before changing anything, and read the console — several of
the claims below come from reading the source, not from watching the app. Say where I am wrong.

---

## 1 + 2. "The App Store isn't offering these plans on this build yet", and the plan rows do nothing

**These are one bug, not two, and the copy is the symptom.**

`mobile/lib/purchaseFlow.ts:194`:
`mode = testMode ? "test" : merged.length > 0 ? "store" : "unavailable"`. `merged` is the server's
plan list intersected with StoreKit's products **by product id** (`:170-179`). Empty intersection →
`unavailable` → `PurchaseSheet.tsx:134` passes `actionable={false}` so every row is inert, and
`:171-176` renders that sentence. Both of my complaints are the same `unavailable` mode.

**So deleting the sentence makes it worse, not production-identical**: a sheet that looks live and
silently ignores a tap. The sentence goes away on its own the moment the build actually receives
products. Fix the mode; leave the copy as the honest fallback for the genuinely unconfigured case,
and tell me if you disagree rather than deleting it quietly.

**Find out why the intersection is empty. Do not assume — the three causes need different fixes:**

- `mobile/lib/entitlement.ts:43-46` says StoreKit returns an **empty product list until the Paid
  Applications Agreement is active**. If that is still unsigned in App Store Connect, no code
  change can produce a tappable row, and I need to be told that in one sentence rather than handed
  a UI patch. Check it first.
- RevenueCat may not be configured in this build (missing API key at runtime) — then `storePlans`
  is null and the intersection is empty for a completely different reason.
- The ids may not match. `purchaseFlow.ts:168` already documents this exact symptom: a product id
  that does not match `PRODUCTS` character for character produces precisely this empty merge.

**Then get to a real checkout.** In order of how production-identical they are:

1. **Sandbox** — products in App Store Connect (Ready to Submit is enough), the RevenueCat offering
   pointing at those ids, a sandbox Apple ID on a device build. Real StoreKit sheet, real receipt,
   real webhook. This is the one I asked for.
2. **A StoreKit configuration file** in the Xcode scheme — local products, real purchase sheet, no
   App Store Connect. Fast, but it bypasses RevenueCat and the webhook, so it proves the sheet and
   not the pipeline. Note `expo prebuild` regenerates the scheme, so this needs a committed
   `.storekit` plus a config plugin or it evaporates on the next build.
3. The existing `mode === "test"` allowlist, which grants access with no payment. Not
   production-identical by design.

Tell me which of these is reachable today and what it needs from me in App Store Connect.

## 3. Restore purchases

Agreed that it cannot be fully exercised yet — but it is not "only once live": once there is a
sandbox purchase, restore works in sandbox. Fold it into whichever path above you get working, and
leave it visible in **every** mode. `PurchaseSheet.tsx:178-184` explains why: Guideline 3.1.1
requires it, and the unavailable mode is exactly where someone who already paid needs it.

## 4. "Manage subscription" should not show without a subscription

Correct, and it is unconditional today — `PurchaseSheet.tsx:201-208`, and again in
`SubscriptionSection.tsx`. It deep-links to Apple's subscriptions screen, which is an empty list
for a trial user.

The payload already carries what decides it: `EntitlementPayload.state`
(`mobile/shared/types/entitlement.ts`). A trial account has **no subscription row at all** — the
trial is derived from `users.created_at` and never stored — so hide the link for `trial`,
`trial_spent`, `trial_expired` and `comped`, and show it for every state that implies a row ever
existed (`subscribed*`, `cancelled_in_period`, `billing_grace`, `expired`, `refunded`, `revoked`).
Put that rule in one exported predicate next to the state type, not inline in two components, and
make it appear immediately after a purchase in the same session.

## 5. The delete-account confirm does not make the phrase stand out

`mobile/components/DeleteAccountSection.tsx:109` bolds the phrase with
`styles.labelStrong` — and that style is `fontFamily: font.medium` (`:214`). **Medium, not
semibold**, which is why "delete account" reads as ordinary text and I typed `delete` and expected
it to work. Use the semibold face, the same one the danger button uses.

While you are in there: the disarmed Delete button is a 14% danger tint with danger-coloured text
(`:242-246`). On screen it still reads as pressable, so the state that says "your typing does not
match yet" looks like the state that says "press me". Make disarmed unmistakably inert.

Check the web dialog (`src/components/DeleteAccountSection.tsx`) for the same two problems and fix
both surfaces — the phrase and the validator are shared
(`shared/lib/accountDeletion.ts`), so the emphasis should not be the thing that differs.

---

## Standing rules

- Reproduce first; if something cannot be reproduced, say so instead of theorising.
- No trimming coverage for time. Mutation-check every new test — reintroduce the bug, watch it go
  red, restore — and name which ones you checked.
- `tsc --noEmit` and the full suite green before committing.
- Commit to `feat/admin-paywall-per-user` and **push** — this PR is already open, so pushing updates
  it. Do not merge.
- These are mobile UI changes riding on a server/admin PR. If that bothers you more than it bothers
  me, say so in one line rather than opening a second PR on your own.
