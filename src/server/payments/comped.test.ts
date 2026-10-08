import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {} }));

import { adminAlertRecipients } from '@/server/auth/admin';
import { isCompedEmail } from './comped';

/**
 * The admin account must never meet the paywall: it is the account that turns
 * the paywall off. The comped list once stayed on the old admin address after
 * the admin moved, and the admin was walled out on the day enforcement began.
 */
describe('isCompedEmail', () => {
  it('comps every address on the admin allowlist', () => {
    for (const admin of adminAlertRecipients()) {
      expect(isCompedEmail(admin)).toBe(true);
      expect(isCompedEmail(admin.toUpperCase())).toBe(true);
    }
  });

  it('still comps the author account', () => {
    expect(isCompedEmail('samuelashirley@gmail.com')).toBe(true);
  });

  it('does not comp an ordinary address or a lookalike of the admin', () => {
    expect(isCompedEmail('someone@example.com')).toBe(false);
    expect(isCompedEmail('sam+x@feraltravels.com')).toBe(false);
    expect(isCompedEmail('sam@feraltravels.co')).toBe(false);
    expect(isCompedEmail(null)).toBe(false);
  });
});
