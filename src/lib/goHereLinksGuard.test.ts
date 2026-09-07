/**
 * Every "go here" affordance is a drive, not a pin.
 *
 * The NEXT STOP button and the arrow on each stop row opened Google Maps on a
 * dropped pin — `/maps/search/?api=1&query=lat,lng`, hand-built in two
 * components beside a `maps.ts` that already knew how to build directions
 * (2026-09-04). The fix is `buildGoHereUrl`; this is the guard that the
 * hand-rolled builder does not come back in a third place. `/maps/search/` is
 * still legitimate for FINDING things near a point (the park route links), so
 * the rule is narrow: the `?api=1&query=` coordinate-pin form, which only ever
 * meant "go here", is banned from components on both platforms.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildGoHereUrl } from './maps';

const root = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('buildGoHereUrl', () => {
  it('is turn-by-turn from the device, with no origin', () => {
    const url = new URL(buildGoHereUrl(45.86, 6.08) as string);
    expect(url.pathname).toBe('/maps/dir/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('destination')).toBe('45.86,6.08');
    expect(url.searchParams.get('dir_action')).toBe('navigate');
    expect(url.searchParams.get('travelmode')).toBe('driving');
    // No origin: Google Maps routes from wherever the device is. Inventing
    // one would send the driver from the wrong place.
    expect(url.searchParams.has('origin')).toBe(false);
  });

  it('is null without coordinates', () => {
    expect(buildGoHereUrl(null, 6.08)).toBeNull();
    expect(buildGoHereUrl(45.86, undefined)).toBeNull();
  });
});

describe('no component hand-builds a coordinate pin for a "go here" action', () => {
  it('the /maps/search/?api=1&query= form is gone from both platforms', () => {
    const hits: string[] = [];
    for (const r of ['src/components', 'src/app', 'mobile/components', 'mobile/app']) {
      for (const file of walk(join(root, r))) {
        const src = readFileSync(file, 'utf8');
        if (/maps\/search\/\?api=1&query=/.test(src)) hits.push(relative(root, file));
      }
    }
    expect(hits).toEqual([]);
  });
});
