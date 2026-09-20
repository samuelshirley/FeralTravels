/**
 * The day's nav buttons wrap inside the card; they never run off it.
 *
 * Bug (iOS, 2026-09-20): a long station name made the "<stop> in Google Maps"
 * button wider than the card, and `styles.card` sets `overflow: "hidden"`, so
 * the end of the button was cut off. On an `isNext` button the NEXT chip is
 * what sits at that end, so the most important button was the one that lost
 * its label.
 *
 * Measured on an iPhone SE (3rd gen) with the real name off a live trip,
 * "Estación de Servicio Repsol". BEFORE: the card ended at x=358 and the
 * button ran to x=363 — 5pt past the card's outer edge, 19pt past its padded
 * content box — and rendered with its right rounded corner squared off by the
 * clip. AFTER: the button ends at x=342, inside the content box, still two
 * lines, nothing truncated.
 *
 * Three properties make the wrap work, and losing any one of them brings the
 * clip back, so this guard reads them out of the stylesheet:
 *
 *   1. `maxWidth: "100%"` on the button — `alignSelf: "flex-start"` keeps a
 *      short button content-width, which is wanted, but on its own it is
 *      UNCAPPED. This is the cap.
 *   2. `flexShrink: 1` on the label — in React Native the Yoga default for
 *      `flexShrink` is 0, NOT 1 as on the web, so without this the text cannot
 *      give and the row simply grows. This is why the web version of the same
 *      affordance never had the bug: CSS `width: fit-content` is self-limiting
 *      and web `flex-shrink` defaults to 1. Verified in a real browser at
 *      390px and 320px — no overflow, no clipping — so `src/components/
 *      LegCard.tsx` was deliberately left alone.
 *   3. `flexShrink: 0` on the NEXT chip — the chip must never be the thing
 *      that gives. RN's default already is 0; it is stated explicitly because
 *      here that default is load-bearing rather than incidental.
 *
 * `syncingPill` is the same shape with the same defect and carries the same
 * fix, so it is guarded too.
 *
 * Mutation-checked: each of the three properties was removed in turn and this
 * file went red on that property alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const legCard = readFileSync(join(root, 'mobile/components/LegCard.tsx'), 'utf8');

/**
 * The body of a single `StyleSheet.create` entry, e.g. `navButton: { … }`.
 *
 * Sliced by brace depth rather than by regex: these blocks contain nested
 * objects, and a lazy `\{[^}]*\}` would stop at the first inner `}` and report
 * a property missing that is plainly there.
 */
function styleBlock(source: string, name: string): string {
  const start = source.indexOf(`${name}: {`);
  expect(start, `${name} is gone from the LegCard stylesheet`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces reading the ${name} style block`);
}

describe('the day nav buttons cannot overflow the card', () => {
  it('navButton is capped at the container width', () => {
    // Without this the button is content-sized with no upper bound and the
    // card's overflow:hidden does the truncating.
    expect(styleBlock(legCard, 'navButton')).toMatch(/maxWidth:\s*["']100%["']/);
  });

  it('navButtonText is the thing that gives, so the label wraps', () => {
    // RN defaults flexShrink to 0. Without this the row never yields and the
    // text pushes the button past the card instead of wrapping.
    expect(styleBlock(legCard, 'navButtonText')).toMatch(/flexShrink:\s*1/);
  });

  it('the NEXT chip never shrinks', () => {
    // The chip sits at the clipped end. It must keep its natural size so the
    // label is what wraps.
    expect(styleBlock(legCard, 'navNextChip')).toMatch(/flexShrink:\s*0/);
  });

  it('the label is never truncated instead of wrapped', () => {
    // Sam asked for wrap, not ellipsis: all of the text stays visible and the
    // button grows to a second line. `numberOfLines` on the label, or
    // `ellipsizeMode`, would hide part of a station name the driver needs.
    const block = styleBlock(legCard, 'navButtonText');
    expect(block).not.toMatch(/textOverflow|ellipsis/);
    // The JSX must not cap the label's line count either.
    const jsx = legCard.slice(legCard.indexOf('navButtons.map('));
    expect(jsx.slice(0, 1200)).not.toMatch(/numberOfLines|ellipsizeMode/);
  });

  it('syncingPill carries the same fix, having had the same defect', () => {
    expect(styleBlock(legCard, 'syncingPill')).toMatch(/maxWidth:\s*["']100%["']/);
    expect(styleBlock(legCard, 'syncingText')).toMatch(/flexShrink:\s*1/);
  });
});
