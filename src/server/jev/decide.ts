import type { MessageTier } from '@/lib/pennyGate';

/**
 * When may Jev's answer stand without asking Haiku?
 *
 * ONLY when it is T1, its top probability is at least `t1Min`, and it leads the
 * runner-up by at least `MIN_MARGIN`. Every other reading — T2, T3, a T1 that
 * is not sure enough — goes to Haiku, and Haiku's answer is final.
 *
 * The asymmetry is the whole design. A wrong T1 costs one planning turn that
 * Penny may answer with "I can't help with that", and it is the answer the
 * gate already fails open to on every error path. A wrong T3 refuses a real
 * driver and puts a strike on their account, and three of those pause Penny
 * for an hour. Nothing in this app may strike a driver on Jev's word, so Jev
 * is allowed to say "go ahead" and nothing else.
 */

/** Top minus second. A 0.85 top with a 0.7 runner-up is not a decision. */
export const MIN_MARGIN = 0.2;

export type DeferReason = 'not_t1' | 'below_t1_min' | 'margin';

export function settlesAsT1(
  reading: { choice: MessageTier; top: number; margin: number },
  t1Min: number
): { settled: true } | { settled: false; reason: DeferReason } {
  if (reading.choice !== 'T1') return { settled: false, reason: 'not_t1' };
  if (!(reading.top >= t1Min)) return { settled: false, reason: 'below_t1_min' };
  if (!(reading.margin >= MIN_MARGIN)) return { settled: false, reason: 'margin' };
  return { settled: true };
}
