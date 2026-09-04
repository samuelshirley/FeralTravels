import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TAP_TO_ANSWER_KINDS,
  cityFromPlace,
  intentPlaceholder,
  isTapToAnswerKind,
  locksComposer,
} from './onboardingForm';

const root = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('tap-to-answer kinds', () => {
  it('select and chips are answered by tapping; nothing else is', () => {
    expect([...TAP_TO_ANSWER_KINDS]).toEqual(['select', 'chips']);
    expect(isTapToAnswerKind('select')).toBe(true);
    expect(isTapToAnswerKind('chips')).toBe(true);
    expect(isTapToAnswerKind('text')).toBe(false);
    expect(isTapToAnswerKind('vehicle')).toBe(false);
    expect(isTapToAnswerKind('handoff')).toBe(false);
  });

  it('chips keeps the composer live; select and vehicle lock it', () => {
    expect(locksComposer('chips')).toBe(false);
    expect(locksComposer('select')).toBe(true);
    expect(locksComposer('vehicle')).toBe(true);
  });

  /*
   * THE STRUCTURAL GUARD. The date step drew three chips that did nothing
   * because the renderer listed `select || chips` while the tap handler bailed
   * on `!== 'select'`. Both surfaces now read the shared predicate, on web and
   * on native — and this fails if either ever spells the list out again. A
   * kind that renders chips is a kind the handler accepts, by construction.
   */
  for (const [label, path] of [
    ['web', 'src/components/ChatPanel.tsx'],
    ['native', 'mobile/components/ChatPanel.tsx'],
  ] as const) {
    it(`${label} ChatPanel: the tap handler and the chip renderer read the same predicate`, () => {
      const src = read(path);
      const pick = src.slice(src.indexOf('submitOnboardingPick'), src.indexOf('submitOnboardingTextAnswer'));
      expect(pick).toContain('isTapToAnswerKind(q.kind)');
      expect(pick).not.toMatch(/kind !== ['"]select['"]/);
      // The renderer: chips are drawn for exactly the tappable kinds.
      expect(src).toContain('isTapToAnswerKind(onboardingQuestion.kind)');
      expect(src).not.toMatch(/kind === ['"]select['"] \|\|\s*onboardingQuestion\??\.kind === ['"]chips['"]/);
    });
  }
});

describe('location seeding', () => {
  it('takes the town out of a "town, country" label', () => {
    expect(cityFromPlace('Girona, Spain')).toBe('Girona');
    expect(cityFromPlace('Tromsø')).toBe('Tromsø');
    expect(cityFromPlace(null)).toBeNull();
    expect(cityFromPlace(' , Spain')).toBeNull();
  });

  it('seeds the first-message placeholder, and falls back to "Where to?"', () => {
    expect(intentPlaceholder('Girona')).toEqual({ city: 'Girona', rest: ' to …' });
    expect(intentPlaceholder(null)).toEqual({ city: null, rest: 'Where to?' });
  });
});
