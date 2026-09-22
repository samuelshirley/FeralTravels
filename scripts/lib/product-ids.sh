# The App Store product ids, read from the server's own `PRODUCTS` list.
#
# SOURCED, never executed. Two callers, deliberately sharing one implementation:
# `scripts/iap-preflight.sh` (does constants.ts agree with the StoreKit file and
# RevenueCat?) and `scripts/storekit-probe.sh` (will StoreKit vend them?). Each
# used to scrape the file its own way, and each way was wrong differently. One
# copy, pinned by a unit test, is the copy somebody is looking at.
#
# ── Why this file exists ───────────────────────────────────────────────────
#
# `grep "id: '"` over `src/server/payments/constants.ts` was the preflight's
# extraction, and it was right while PRODUCTS was the only array in the file.
# Then the breakers moved in beside it — six `BreakerSpec` entries, each with an
# `id:` of its own — and on 2026-09-22 the preflight reported two FAILs against
# a setup where constants.ts, the .storekit file and RevenueCat's live offering
# all agreed exactly: `anthropic_spend_1h`, `manual_lock` and the rest were
# being compared as product ids. A check that cries wolf is a check nobody
# reads, and this one guards the purchase sheet.
#
# The probe's `com\.feraltravels\.ios\.[a-z]+` is the same bug facing the other
# way: right today, and silently empty the day the bundle id changes.
#
# So the extraction is scoped to the PRODUCTS block — from
# `export const PRODUCTS` to the FIRST `] as const;` after it. Stopping at the
# first one is load-bearing: the breakers block ends with a second.
#
# If the block cannot be found it FAILS, loudly, rather than printing nothing.
# An empty list compares unequal to everything, which is another false FAIL
# with a worse message.
#
# Guarded by `src/server/payments/productIdExtraction.test.ts`, which asserts
# this prints exactly `PRODUCTS.map(p => p.id)`.

# The product ids, sorted, one per line. Returns 1 (with a message on stderr)
# when the PRODUCTS block is not where this expects it.
product_ids() {
  local root out
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  out="$(awk '/^export const PRODUCTS/{f=1} f{print} f && /^\] as const;|^\];/{exit}' \
    "$root/src/server/payments/constants.ts" \
    | grep -oE "id: '[^']+'" | sed "s/id: '//;s/'$//" | sort)"
  [ -n "$out" ] || { echo "product_ids: no ids found — the PRODUCTS block in src/server/payments/constants.ts moved" >&2; return 1; }
  printf '%s\n' "$out"
}
