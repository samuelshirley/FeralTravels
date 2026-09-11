import { describe, expect, it } from 'vitest';
import {
  planReactivation,
  preRevokeStatusFor,
  reactivationLandingLine,
  type RevocableRow,
} from './reactivation';
import type { SubscriptionStatus } from '@/types/entitlement';

const STATUSES: SubscriptionStatus[] = [
  'active',
  'grace',
  'cancelled',
  'expired',
  'refunded',
  'revoked',
];

describe('preRevokeStatusFor', () => {
  it('records whatever the status was, for every status there is', () => {
    for (const status of STATUSES.filter((s) => s !== 'revoked')) {
      expect(preRevokeStatusFor({ status, preRevokeStatus: null }), status).toBe(status);
    }
  });

  it("records 'none' when there is no row to overwrite", () => {
    // A revoke of a trial user creates the row. What the undo restores is the
    // absence of one, not a status — recording 'expired' here would be a lie
    // that outlives everyone who could correct it.
    expect(preRevokeStatusFor(null)).toBe('none');
  });

  it('never lets a second revoke overwrite the first answer', () => {
    expect(preRevokeStatusFor({ status: 'revoked', preRevokeStatus: 'active' })).toBe('active');
    expect(preRevokeStatusFor({ status: 'revoked', preRevokeStatus: 'none' })).toBe('none');
    // Nothing recorded stays nothing recorded — inventing one here would make a
    // pre-migration row silently re-activatable to a guess.
    expect(preRevokeStatusFor({ status: 'revoked', preRevokeStatus: null })).toBeNull();
  });
});

describe('planReactivation', () => {
  it('restores the recorded status', () => {
    for (const status of STATUSES.filter((s) => s !== 'revoked')) {
      const plan = planReactivation({ status: 'revoked', preRevokeStatus: status });
      expect(plan, status).toEqual({ ok: true, action: 'restore', status });
    }
  });

  it("deletes the row when there was none before the revoke", () => {
    expect(planReactivation({ status: 'revoked', preRevokeStatus: 'none' })).toEqual({
      ok: true,
      action: 'clear_row',
    });
  });

  /**
   * The three refusals, and why each is a refusal rather than a no-op.
   *
   * A silent success on an account that did not change is how a support thread
   * ends with two people believing different things about the same account. So
   * each of these carries a sentence naming the mistake, and the route turns it
   * into a 400 rather than a 200.
   */
  it('refuses an account that was never revoked', () => {
    const plan = planReactivation({ status: 'active', preRevokeStatus: null });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('not_revoked');
    // Says which status it actually holds, so the admin can see they are
    // looking at the wrong account rather than at a broken button.
    expect(plan.message).toContain('active');
  });

  it('refuses an account with no plan row at all', () => {
    const plan = planReactivation(null);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('no_subscription_row');
  });

  it('refuses a row revoked before the undo existed, and says why', () => {
    /*
     * There are such rows in production. The status they should come back to is
     * recorded nowhere, and guessing `active` would hand a free plan to an
     * account that had already expired. The history that could inform a real
     * answer is in `subscription_events`, and reading it is a job for a human.
     */
    const plan = planReactivation({ status: 'revoked', preRevokeStatus: null });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('no_pre_revoke_status');
    expect(plan.message).toContain('subscription events');
  });

  it('gives every refusal its own sentence', () => {
    const messages = [
      planReactivation(null),
      planReactivation({ status: 'active', preRevokeStatus: null }),
      planReactivation({ status: 'revoked', preRevokeStatus: null }),
    ].map((p) => (p.ok ? '' : p.message));
    expect(new Set(messages).size).toBe(3);
    for (const m of messages) expect(m.length).toBeGreaterThan(20);
  });
});

describe('reactivationLandingLine', () => {
  const revoked = (pre: RevocableRow['preRevokeStatus']): RevocableRow => ({
    status: 'revoked',
    preRevokeStatus: pre,
  });

  it('names the status AND the term the admin is handing back', () => {
    const line = reactivationLandingLine(planReactivation(revoked('active')), '2027-03-14');
    expect(line).toContain('active');
    expect(line).toContain('2027-03-14');
  });

  it('says "no end date" only when the row genuinely has none', () => {
    // An admin grant or a lifetime promo. NOT the same as a date in the past,
    // which the caller must still pass — see the note on the parameter.
    expect(reactivationLandingLine(planReactivation(revoked('active')), null)).toContain(
      'no end date',
    );
    const past = reactivationLandingLine(planReactivation(revoked('active')), '2026-01-01');
    expect(past).toContain('2026-01-01');
    expect(past).not.toContain('no end date');
  });

  it('says what a trial user lands back on, which is nothing', () => {
    const line = reactivationLandingLine(planReactivation(revoked('none')), null);
    expect(line).toContain('no plan');
    expect(line).toContain('trial');
  });

  it('has no line to offer for a refusal', () => {
    expect(reactivationLandingLine(planReactivation(revoked(null)), '2027-03-14')).toBeNull();
  });
});
