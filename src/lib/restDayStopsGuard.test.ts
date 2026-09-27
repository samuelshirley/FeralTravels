import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A base day (`leg_type: 'rest'`) shows its stops on iOS.
 *
 * `getTrip` returned a rest leg's stops and the map plotted them, but the
 * card's `expanded && isRestDay` branch never rendered StopsSection, so a stop
 * Penny or the user put on a base day was saved and never listed. The web half
 * is covered by `LegCard.restDayStops.test.tsx` (jsdom). This file is for the
 * NATIVE half: `mobile/` has no test runner, so — like `fuelEmptyStateGuard` —
 * it reads the components as text.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const LEG_CARD = 'mobile/components/LegCard.tsx';
const STOPS = 'mobile/components/StopsSection.tsx';

/** The rest-day branch: from its opening condition to the drive branch's. */
function restBranch(): string {
  const src = read(LEG_CARD);
  const start = src.indexOf('expanded && isRestDay');
  const end = src.indexOf('expanded && !isRestDay');
  expect(start, `${LEG_CARD}: no "expanded && isRestDay" branch`).toBeGreaterThan(-1);
  expect(end, `${LEG_CARD}: no "expanded && !isRestDay" branch after it`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('native base day stops', () => {
  it('the rest-day branch of LegCard renders StopsSection in restDay mode', () => {
    const branch = restBranch();
    const at = branch.indexOf('<StopsSection');
    expect(at, `${LEG_CARD}: the rest-day branch renders no <StopsSection>`).toBeGreaterThan(-1);
    const element = branch.slice(at, branch.indexOf('/>', at));
    expect(element, `${LEG_CARD}: the rest-day StopsSection is not in restDay mode`).toMatch(
      /\brestDay\b/,
    );
    expect(element, `${LEG_CARD}: the rest-day StopsSection is not given the leg's stops`).toMatch(
      /initialStops=\{leg\.stops\}/,
    );
    // Fuel does not apply to a base day; handing it fuel state invites the UI back.
    expect(element, `${LEG_CARD}: the rest-day StopsSection is passed fuel props`).not.toMatch(
      /fuel(Status|PlanError|Loading)=/,
    );
  });

  it('StopsSection declares restDay and gates on it', () => {
    const src = read(STOPS);
    expect(src, `${STOPS}: no restDay prop declared`).toMatch(/restDay\?:\s*boolean/);
    // Empty base day → nothing drawn at all (no bare STOPS heading).
    expect(src, `${STOPS}: an empty base day is not gated to null`).toMatch(
      /if\s*\(\s*restDay\s*&&[^)]*activeStops\.length\s*===\s*0[^)]*dismissedStops\.length\s*===\s*0\s*\)\s*return null/,
    );
    // The fuel UI and the fuel empty-state copy are keyed off restDay.
    expect(src, `${STOPS}: fuel UI is not gated on restDay`).toMatch(/!restDay/);
  });
});
