import { describe, it, expect, vi } from 'vitest';

// Same shim the other guard test uses (auth/test-endpoints.test.ts): the module
// is correctly marked server-only, and vitest's node environment is not a
// server component.
vi.mock('server-only', () => ({}));

import { isTestPurchaseAllowed, isTestPurchaseAddress } from './testPurchase';

const ON = { SUBSCRIPTION_TESTING: '1' };
const OFF = {};

describe('test-purchase gate', () => {
  it('needs BOTH the address shape and the arming switch', () => {
    expect(isTestPurchaseAllowed('sam+trial-a1@feraltravels.com', ON)).toBe(true);
    // Right address, switch off — the switch is what turns this off the day
    // RevenueCat goes live, with no deploy.
    expect(isTestPurchaseAllowed('sam+trial-a1@feraltravels.com', OFF)).toBe(false);
    // Armed, wrong address. The env var can never widen the shape.
    expect(isTestPurchaseAllowed('someone@example.com', ON)).toBe(false);
  });

  it('accepts a fresh unique address every run', () => {
    for (const local of ['trial-1', 'trial-20260826-1a2b', 'trial-x']) {
      expect(isTestPurchaseAddress(`sam+${local}@feraltravels.com`)).toBe(true);
    }
  });

  it('refuses the addresses somebody would reach for by mistake', () => {
    const no = [
      // The bare account. Comping or granting on this would hit the real one.
      'sam@feraltravels.com',
      // A different plus-tag — the `trial-` prefix is load-bearing, so an
      // address used for anything else can never pick up a free subscription.
      'sam+notes@feraltravels.com',
      // The author's actual account.
      'samuelashirley@gmail.com',
      // A lookalike domain. This is the attack the anchors exist for.
      'sam+trial-a@feraltravels.com.evil.com',
      'sam+trial-a@notferaltravels.com',
      // Subdomain, which we do not own the mail for in the same way.
      'sam+trial-a@mail.feraltravels.com',
      // Empty tag.
      'sam+trial-@feraltravels.com',
      '',
      null,
      undefined,
    ];
    for (const addr of no) {
      expect(isTestPurchaseAddress(addr as string), `${addr} must be refused`).toBe(false);
    }
  });

  it('is case- and whitespace-insensitive, because a typed address is', () => {
    expect(isTestPurchaseAddress('  SAM+Trial-A1@FeralTravels.com ')).toBe(true);
  });
});
