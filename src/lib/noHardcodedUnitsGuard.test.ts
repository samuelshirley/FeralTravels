/**
 * No component writes a distance unit into a string.
 *
 * The 2026-09-04 audit found four places rendering `${n} km` straight into
 * JSX — the itinerary headline, a segment total, the NEXT STOP row and every
 * stop row in an open day — so an imperial user read kilometres in exactly the
 * places a driver looks most, while `StopCard` carried a comment describing
 * this same bug being fixed once already. Fixing four sites is a detection
 * test; this is the structural one: after `formatKm` / `approxDistance` /
 * `Distance`, a `km` or `mi` literal next to a number in a component is
 * ALWAYS a bug, on either platform, so the suite refuses it.
 *
 * What counts: inside a string or template literal, a unit word right after
 * an interpolation (`${x} km`) or a digit (`'500 km'`), and the `{n} km from
 * start` JSX shape. Comments are stripped first. A line that genuinely needs
 * a unit word in prose — the onboarding starter "150 km in the tank" is a
 * sentence the user edits, not a distance the app rendered — carries the
 * marker `units-literal-ok` on the same line.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..', '..');

const ROOTS = ['src/components', 'src/app', 'mobile/components', 'mobile/app'];
// Route handlers return JSON and log lines, not screens. A unit in an API
// error message ("set it between 200 and 1500 km") is a server contract
// stated in the canonical unit, and is not what this guard is about.
const SKIP = [/^src\/app\/api\//];
const MARKER = 'units-literal-ok';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const OFFENDERS: RegExp[] = [
  // `${distance} km` / `${n} mi` inside a template literal
  /\$\{[^}]*\}\s*(km|mi)\b/,
  // '500 km' / ' · 390 km' / "300 mi" — a number and a unit inside a literal
  /['"`][^'"`\n]*?\b\d[\d,.]*\s*(km|mi)\b/,
  // {Math.round(x)} km from start — a JSX text node right after an expression
  /\}\s+(km|mi)\s+from\b/,
];

/** Every offending line, as `path:line: text`. */
export function findHardcodedUnits(): string[] {
  const hits: string[] = [];
  for (const r of ROOTS) {
    for (const file of walk(join(root, r))) {
      if (SKIP.some((re) => re.test(relative(root, file)))) continue;
      const raw = readFileSync(file, 'utf8');
      const rawLines = raw.split('\n');
      const lines = stripComments(raw).split('\n');
      lines.forEach((line, i) => {
        // The marker is a comment, so it is read off the RAW line.
        if (rawLines[i]?.includes(MARKER)) return;
        if (OFFENDERS.some((re) => re.test(line))) {
          hits.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  return hits;
}

describe('distances render through the units layer', () => {
  it('no component carries a km/mi literal next to a number', () => {
    expect(findHardcodedUnits()).toEqual([]);
  });

  it('the scanner sees what it is meant to see', () => {
    // A self-check, so a regex edit that stops matching everything does not
    // pass this suite silently.
    const sample = [
      'const a = `${Math.round(km)} km`;',
      "const b = ' · 390 km';",
      '<Text>{Math.round(d)} km from start</Text>',
      'const ok = formatKm(km, units);',
    ];
    expect(sample.map((l) => OFFENDERS.some((re) => re.test(l)))).toEqual([true, true, true, false]);
  });
});
