import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { PRODUCTS } from './constants';

/**
 * `scripts/iap-preflight.sh` and `scripts/storekit-probe.sh` do not import
 * PRODUCTS — they are bash, so they read it out of this directory's
 * constants.ts as text, through `scripts/lib/product-ids.sh`. That makes the
 * text extraction a second definition of the product list, and this test is
 * what keeps it equal to the first.
 *
 * The bug it is here to catch already happened: the preflight grepped the
 * whole of constants.ts for `id: '…'`, the breakers moved in beside PRODUCTS
 * with an `id:` each, and on 2026-09-22 the preflight reported the purchase
 * setup broken — twice — while every real product id agreed. A grep over a
 * file that grew a second array is exactly this shape, and nothing else fails
 * when it happens.
 */
describe('scripts/lib/product-ids.sh', () => {
  it('prints exactly the ids in PRODUCTS, sorted', () => {
    const out = execFileSync('bash', ['-c', '. scripts/lib/product-ids.sh && product_ids'], {
      encoding: 'utf8',
    });

    expect(out.trim().split('\n')).toEqual([...PRODUCTS.map((p) => p.id)].sort());
  });
});
