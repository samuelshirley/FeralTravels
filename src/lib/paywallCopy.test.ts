import { describe, expect, it } from 'vitest';
import { blockNoticeFor, SUPPORT_EMAIL } from './paywallCopy';
import type { BlockReason } from '@/types/entitlement';

const ALL: BlockReason[] = ['trial_over', 'subscription_over', 'usage_cap', 'revoked'];

describe('web block copy', () => {
  it('says something different for every reason', () => {
    const headings = new Set(ALL.map((r) => blockNoticeFor(r).heading));
    expect(headings.size).toBe(ALL.length);

    // The design doc calls trial-ended and subscription-ended two different
    // moments. Sharing one string across them is the shortcut this guards.
    const trial = blockNoticeFor('trial_over');
    const sub = blockNoticeFor('subscription_over');
    expect(trial.body.join(' ')).not.toBe(sub.body.join(' '));
  });

  it('never accuses the user when the cap fires', () => {
    const text = [blockNoticeFor('usage_cap').heading, ...blockNoticeFor('usage_cap').body]
      .join(' ')
      .toLowerCase();
    for (const accusation of ['exceeded', 'too much', 'abuse', 'limit reached', 'violation']) {
      expect(text).not.toContain(accusation);
    }
    // It has to point somewhere a human answers.
    expect(blockNoticeFor('usage_cap').action.href).toBe(`mailto:${SUPPORT_EMAIL}`);
  });

  it('sells on the two states that can be fixed by subscribing', () => {
    expect(blockNoticeFor('trial_over').tone).toBe('sell');
    expect(blockNoticeFor('subscription_over').tone).toBe('sell');
    expect(blockNoticeFor('usage_cap').tone).toBe('apologise');
    expect(blockNoticeFor('revoked').tone).toBe('apologise');
  });

  it('does not promise readable trips in the one state where they are gone', () => {
    // `refunded` / `revoked` set canViewExistingTrips=false. Copy claiming the
    // itinerary is still there would be a lie the page itself contradicts.
    const text = blockNoticeFor('revoked').body.join(' ').toLowerCase();
    expect(text).not.toContain('stay readable');
    expect(text).toContain('unavailable');
  });
});
