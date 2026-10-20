/**
 * The server's fallback subscription titles (Guideline 3.1.2(c)).
 *
 * The purchase sheet prefers StoreKit's localized display name for each plan,
 * and falls back to `PRODUCTS[].title` when the store cannot be reached or its
 * title is blank. The fallback must exist — an untitled row is the 1.0 (12)
 * rejection of 2026-10-19 — and must read like the store's own, so it is held
 * equal to the products' display names in the .storekit file, which mirrors
 * App Store Connect. Part of `src/lib/subscriptionTitleGuard.test.ts`; it lives
 * here because nothing outside payments/ may import its constants.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTS } from './constants';

describe('PRODUCTS fallback titles', () => {
  it('every product has a title equal to its .storekit display name', () => {
    const storekit = JSON.parse(
      readFileSync(path.join(process.cwd(), 'mobile/storekit/FeralTravels.storekit'), 'utf8')
    ) as {
      subscriptionGroups: {
        subscriptions: { productID: string; localizations: { displayName: string }[] }[];
      }[];
    };
    const displayNames = new Map(
      storekit.subscriptionGroups
        .flatMap((g) => g.subscriptions)
        .map((s) => [s.productID, s.localizations[0]?.displayName])
    );
    for (const p of PRODUCTS) {
      expect(p.title.trim(), p.id).not.toBe('');
      expect(displayNames.get(p.id), p.id).toBe(p.title);
    }
  });
});
