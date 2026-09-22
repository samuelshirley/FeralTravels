import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('admits it when ADMIN_EMAILS names only the former address (the production lockout)', async () => {
    // Production shipped 8c8becf with ADMIN_EMAILS=samuelashirley@gmail.com.
    // An env naming nobody on the allowlist must not empty the admin set.
    process.env.ADMIN_EMAILS = FORMER_ADMIN;
    expect(await isAdminEmail(ADMIN)).toBe(true);
    expect(await isAdminEmail(FORMER_ADMIN)).toBe(false);
  });

  it('still narrows when ADMIN_EMAILS names an allowlisted address', async () => {
    process.env.ADMIN_EMAILS = `${FORMER_ADMIN}, ${ADMIN}`;
    expect(await isAdminEmail(ADMIN)).toBe(true);
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

describe('.env.example ADMIN_EMAILS', () => {
  // A developer copying .env.example must land on a working admin, not the
  // empty intersection that locked /admin out after 8c8becf.
  const line = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('ADMIN_EMAILS='));
  const named = (line ?? '').slice('ADMIN_EMAILS='.length).split(',').map((s) => s.trim()).filter(Boolean);

  it('names at least one address', () => {
    expect(named.length).toBeGreaterThan(0);
  });

  it('names only addresses on ADMIN_ALLOWLIST', () => {
    for (const email of named) expect(isOnAdminAllowlist(email), email).toBe(true);
  });
});
