import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A day that needs no fuel stop must read as a positive answer on BOTH
 * platforms, and must never be confused with a day too remote to plan one.
 *
 * Those two outcomes came from the same planner branch until 2026-09-09: a burn
 * accumulated across never-opened days made the tank arithmetic go negative, the
 * planner reported a gap, and trip `ab824cde` day 11 showed the driver "No fuel
 * stations found along this leg — Next fuel is 44 km ahead, beyond safe range
 * (-1896 km)" for a leg whose real answer was one ordinary stop.
 *
 * The web half is covered properly in `StopsSection.test.tsx` (jsdom). This file
 * exists for the NATIVE half: `mobile/` has no test runner and CI's unit job
 * installs no `mobile/node_modules`, so the repo's idiom is to read the
 * component as text — the same trick as `goHereLinksGuard` and
 * `deleteAccountEmphasisGuard`.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const WEB = 'src/components/StopsSection.tsx';
const NATIVE = 'mobile/components/StopsSection.tsx';

/** The one sentence for "this day fits on the fuel you already have". */
const NEEDED_NONE = 'No fuel stop needed on this day';
/** The remote-route warning headline. */
const REMOTE = 'No fuel stations found along this leg';

describe('the "no stop needed" state', () => {
  it('uses the same sentence on both platforms', () => {
    for (const f of [WEB, NATIVE]) {
      expect(read(f), `${f} lost the positive empty-state copy`).toContain(NEEDED_NONE);
    }
  });

  it('is gated on a sourced day, on both platforms', () => {
    // `ready` is the only status that means "we searched and nothing is needed".
    // Showing it for `none` would claim an answer we never computed.
    for (const f of [WEB, NATIVE]) {
      const src = read(f);
      const at = src.indexOf(NEEDED_NONE);
      expect(at, `${f}: copy not found`).toBeGreaterThan(-1);
      // The status test sits immediately above the string in both files.
      const preceding = src.slice(Math.max(0, at - 400), at);
      expect(preceding, `${f}: positive line is not gated on fuelStatus === ready`).toMatch(
        /fuelStatus\s*===\s*["']ready["']/
      );
    }
  });

  it('excludes the remote-route status from the positive branch, on both platforms', () => {
    for (const f of [WEB, NATIVE]) {
      const src = read(f);
      const at = src.indexOf(NEEDED_NONE);
      const preceding = src.slice(Math.max(0, at - 600), at);
      expect(preceding, `${f}: no_stations_found is not excluded`).toMatch(
        /fuelStatus\s*!==\s*["']no_stations_found["']/
      );
      expect(preceding, `${f}: failed is not excluded`).toMatch(
        /fuelStatus\s*!==\s*["']failed["']/
      );
    }
  });

  it('keeps the remote warning as its own block, on both platforms', () => {
    for (const f of [WEB, NATIVE]) {
      expect(read(f), `${f} lost the remote-route warning`).toContain(REMOTE);
    }
  });

  it('never hardcodes a negative range into either component', () => {
    // The sentence the driver actually saw. It is now unrepresentable in the
    // planner (`PlacementTankStateInvalid`); this makes sure nobody
    // reintroduces it as UI copy.
    for (const f of [WEB, NATIVE]) {
      expect(read(f)).not.toMatch(/beyond safe range/i);
    }
  });
});
