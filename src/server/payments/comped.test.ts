import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {} }));

import { isCompedEmail } from './comped';

describe('isCompedEmail', () => {
  it("comps the author's own address", () => {
    expect(isCompedEmail(' SamuelAShirley@gmail.com ')).toBe(true);
  });

  it('comps no plus-address — plus-addressing is public, and the canary is gone (2026-11-12)', () => {
    for (const addr of [
      'samuelashirley+canary@gmail.com',
      'samuelashirley+canary-ios@gmail.com',
      'samuelashirley+canary2@gmail.com',
      'samuelashirley+x@gmail.com',
      'canary@gmail.com',
    ]) {
      expect(isCompedEmail(addr), addr).toBe(false);
    }
  });
});
