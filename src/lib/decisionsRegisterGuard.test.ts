import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `docs/decisions.md` and the guard tests describe the same world.
 *
 * The register's whole claim is that a line reading *Enforced by:* `foo.test.ts`
 * means a machine will refuse the regression. That claim is worth exactly as
 * much as its accuracy — a register naming a test that was renamed away is the
 * same failure as CLAUDE.md describing a data source that was replaced seven
 * weeks earlier, and it fails in the same direction: the reader believes
 * something is checked when nothing is.
 *
 * So: every test the register names must exist, and every guard that exists must
 * be named. The second half is the one that catches drift in practice — writing
 * a guard and forgetting to update the register leaves a decision reading NOT
 * ENFORCED while a test quietly enforces it, and the next person duplicates it.
 */

const ROOT = join(__dirname, '..', '..');
const register = readFileSync(join(ROOT, 'docs/decisions.md'), 'utf8');

/** Every `*Guard.test.ts` in src/lib — this repo's convention for a decision guard. */
const guards = readdirSync(join(ROOT, 'src/lib')).filter((n) => /Guard\.test\.tsx?$/.test(n));

describe('the register points at tests that exist', () => {
  it('names at least one test per enforced decision', () => {
    // Sanity: the register is actually populated.
    expect(register.length).toBeGreaterThan(1000);
    expect(register).toMatch(/Enforced by:/);
  });

  it('every test file it names is real', () => {
    const claimed = new Set(
      [...register.matchAll(/`([A-Za-z0-9._/-]+\.test\.tsx?)`/g)].map((m) => m[1]),
    );
    const missing: string[] = [];
    for (const c of claimed) {
      const base = c.split('/').pop() as string;
      // The register writes bare filenames; find it anywhere under src/ or e2e/.
      const found =
        existsSomewhere(join(ROOT, 'src'), base) ||
        existsSomewhere(join(ROOT, 'e2e'), base) ||
        existsSomewhere(join(ROOT, 'mobile'), base);
      if (!found) missing.push(c);
    }
    expect(missing, 'The register names tests that do not exist.').toEqual([]);
  });
});

describe('every guard is in the register', () => {
  it('no guard test is missing from docs/decisions.md', () => {
    const unlisted = guards.filter((g) => !register.includes(g));
    expect(
      unlisted,
      'A guard nobody recorded leaves a decision reading NOT ENFORCED while a test ' +
        'quietly enforces it — and the next person writes it again.',
    ).toEqual([]);
  });
});

function existsSomewhere(dir: string, name: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((d) =>
      d.isDirectory() ? `d:${d.name}` : `f:${d.name}`,
    );
  } catch {
    return false;
  }
  for (const e of entries) {
    const [kind, n] = [e.slice(0, 1), e.slice(2)];
    if (n === 'node_modules' || n.startsWith('.')) continue;
    if (kind === 'f' && n === name) return true;
    if (kind === 'd' && existsSomewhere(join(dir, n), name)) return true;
  }
  return false;
}
