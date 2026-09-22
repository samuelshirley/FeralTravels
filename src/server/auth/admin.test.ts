import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// `isAdminEmail`'s third condition is a users-row lookup; each test sets what
// that lookup returns.
let rows: Array<{ id: string; isAdmin: boolean }> = [];
vi.mock('@/server/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  },
}));

import { adminAlertRecipients, isAdminEmail, isOnAdminAllowlist } from './admin';

/**
 * The admin identity is `sam@feraltravels.com` — a mailbox on our own domain,
 * not a personal Gmail. Every other test that mentions an admin-looking address
 * uses it as a real person who must be REFUSED something, so none of them would
 * notice the allowlist pointing somewhere else. This file is the one that does.
 */
const ADMIN = 'sam@feraltravels.com';
const FORMER_ADMIN = 'samuelashirley@gmail.com';

describe('ADMIN_ALLOWLIST', () => {
  it('is exactly the feraltravels.com admin mailbox', () => {
    expect(adminAlertRecipients()).toEqual([ADMIN]);
  });

  it('matches case-insensitively', () => {
    expect(isOnAdminAllowlist('SAM@FeralTravels.com')).toBe(true);
  });

  it('no longer carries the personal gmail address', () => {
    expect(isOnAdminAllowlist(FORMER_ADMIN)).toBe(false);
  });

  it('does not match a plus-tag or a lookalike domain', () => {
    for (const email of [
      'sam+trial-a@feraltravels.com',
      'sam@feraltravels.com.evil.com',
      'sam@notferaltravels.com',
      '',
      null,
      undefined,
    ]) {
      expect(isOnAdminAllowlist(email), `${email}`).toBe(false);
    }
  });
});

describe('isAdminEmail', () => {
  const savedEnv = process.env.ADMIN_EMAILS;
  beforeEach(() => {
    rows = [{ id: 'u1', isAdmin: true }];
    delete process.env.ADMIN_EMAILS;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedEnv;
  });

  it('admits the admin mailbox with ADMIN_EMAILS unset and a verified admin row', async () => {
    expect(await isAdminEmail(ADMIN)).toBe(true);
  });

  it('admits it when ADMIN_EMAILS names it', async () => {
    process.env.ADMIN_EMAILS = ADMIN;
    expect(await isAdminEmail(ADMIN)).toBe(true);
  });

  it('locks it out when ADMIN_EMAILS still names the old address', async () => {
    // The deploy trap: ADMIN_EMAILS can only narrow the allowlist, so an env
    // left pointing at the former address filters the new one straight out.
    process.env.ADMIN_EMAILS = FORMER_ADMIN;
    expect(await isAdminEmail(ADMIN)).toBe(false);
    expect(await isAdminEmail(FORMER_ADMIN)).toBe(false);
  });

  it('refuses the admin mailbox without a verified row flagged is_admin', async () => {
    rows = [];
    expect(await isAdminEmail(ADMIN)).toBe(false);
    rows = [{ id: 'u1', isAdmin: false }];
    expect(await isAdminEmail(ADMIN)).toBe(false);
  });

  it('refuses the former address even with an admin row and a permitting env', async () => {
    process.env.ADMIN_EMAILS = `${ADMIN},${FORMER_ADMIN}`;
    expect(await isAdminEmail(FORMER_ADMIN)).toBe(false);
  });
});
