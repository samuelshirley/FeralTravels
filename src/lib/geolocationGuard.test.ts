import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * All client geolocation goes through ONE owner per platform. Decision H6.
 *
 * Web: `DeviceLocationContext` owns the single on-load prompt, the live
 * `watchPosition`, the Permissions-API `onchange` subscription and the one
 * reverse geocode per session. Native: `mobile/lib/location.tsx`, plus the
 * Settings row that can open iOS Settings.
 *
 * The bug this prevents: `useNextStop` used to check the permission ONCE at
 * card-expand, so a state of 'prompt' (dialog on screen, unanswered) locked it
 * to 'unavailable' for the whole mount — granting did nothing, and desktop
 * showed the location popup AND the full nav list at the same time. A second
 * caller cannot see the first one's subscription; that is the whole reason for
 * a single owner.
 */

const ROOT = join(__dirname, '..', '..');

/** The sanctioned owners, one per platform. */
const OWNERS = [
  'src/components/DeviceLocationContext.tsx',
  'mobile/lib/location.tsx',
  'mobile/components/LocationSection.tsx',
];

const APIS = [
  { re: /navigator\.geolocation/, what: 'the browser Geolocation API' },
  { re: /from ['"]expo-location['"]/, what: 'expo-location' },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'mobile'))]
  .map((f) => relative(ROOT, f).split('\\').join('/'))
  .filter((f) => !f.endsWith('geolocationGuard.test.ts'));

describe('one geolocation owner per platform', () => {
  for (const { re, what } of APIS) {
    it(`only the owners touch ${what}`, () => {
      const hits = files
        .filter((f) => !OWNERS.includes(f))
        .filter((f) => re.test(readFileSync(join(ROOT, f), 'utf8')));
      expect(
        hits,
        `Consume the shared location context instead. A second caller cannot see the ` +
          `first one's permission subscription, which is how granting stopped working.`,
      ).toEqual([]);
    });
  }

  it('the owners are still there', () => {
    for (const o of OWNERS) {
      expect(() => readFileSync(join(ROOT, o), 'utf8'), `${o} is missing`).not.toThrow();
    }
  });
});
