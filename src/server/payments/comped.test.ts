import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {} }));

import { isCompedEmail } from './comped';

describe('isCompedEmail — the production canaries', () => {
  it('comps exactly the two canary accounts, so a lapsed trial cannot page as an outage', () => {
    expect(isCompedEmail('samuelashirley+canary@gmail.com')).toBe(true);
    expect(isCompedEmail(' SamuelAShirley+Canary-iOS@gmail.com ')).toBe(true);
  });

  it('comps no other plus-address — plus-addressing is public', () => {
    for (const addr of [
      'samuelashirley+canary2@gmail.com',
      'samuelashirley+canary-ios2@gmail.com',
      'samuelashirley+canaryx@gmail.com',
      'samuelashirley+x@gmail.com',
      'canary@gmail.com',
    ]) {
      expect(isCompedEmail(addr), addr).toBe(false);
    }
  });
});
