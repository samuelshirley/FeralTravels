import { describe, expect, it } from 'vitest';

import { deriveDriveLegTitle, resolveLegTitle } from './legTitle';

describe('deriveDriveLegTitle', () => {
  it('is start → end', () => {
    expect(deriveDriveLegTitle('Austin', 'Marfa')).toBe('Austin → Marfa');
  });

  it('trims, because a stray space becomes a visible double space', () => {
    expect(deriveDriveLegTitle('  Austin ', ' Marfa  ')).toBe('Austin → Marfa');
  });

  it('returns null rather than half a title', () => {
    expect(deriveDriveLegTitle('Austin', null)).toBeNull();
    expect(deriveDriveLegTitle(null, 'Marfa')).toBeNull();
    expect(deriveDriveLegTitle('', '')).toBeNull();
    expect(deriveDriveLegTitle('   ', 'Marfa')).toBeNull();
  });
});

describe('resolveLegTitle', () => {
  it('overrides an authored title on a drive leg — the trip 1b1cc80b bug', () => {
    // Haiku titled a leg ending in Marfa "Austin → Big Bend (Day 1)".
    expect(
      resolveLegTitle({
        legType: 'drive',
        startName: 'Austin',
        endName: 'Marfa',
        fallback: 'Austin → Big Bend (Day 1)',
      })
    ).toBe('Austin → Marfa');
  });

  it('leaves a rest leg alone — it is not a journey', () => {
    expect(
      resolveLegTitle({
        legType: 'rest',
        startName: 'Girona',
        endName: 'Girona',
        fallback: 'Girona (base day)',
      })
    ).toBe('Girona (base day)');
  });

  it('falls back when a drive leg has no endpoints yet', () => {
    expect(
      resolveLegTitle({ legType: 'drive', startName: null, endName: null, fallback: 'Day 1' })
    ).toBe('Day 1');
  });

  it('treats a missing leg_type as drive, which is the column default', () => {
    expect(
      resolveLegTitle({ legType: null, startName: 'A', endName: 'B', fallback: 'anything' })
    ).toBe('A → B');
  });
});
