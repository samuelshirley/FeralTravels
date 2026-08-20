/**
 * The mirror guard the sync script's header has always promised and the repo
 * has never actually had.
 *
 * mobile/shared/ is a COPY of the DOM-free modules in src/lib and src/types,
 * produced by scripts/sync-shared.mjs. Nothing enforced that the copy matched
 * its source, and the script itself threw a ReferenceError before writing a
 * single file, so "run the sync" was not even a working manual fallback.
 *
 * This matters more now than it did: the Mobile workflow publishes mobile/
 * over the air on merge, so a stale mirror reaches devices on its own rather
 * than waiting for a native build and someone noticing. A silent divergence
 * between what the web computes and what the app computes — leg day maths,
 * vehicle range, next-stop selection — is exactly the class of bug that gets
 * diagnosed as "the app is wrong" days later.
 *
 * Deliberately a vitest spec in src/ rather than a standalone script: that way
 * it runs in the existing `unit` project on every PR, with no new CI job and
 * no chance of being the check nobody remembers to call.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Plain ESM JS with no declarations; tsconfig's allowJs infers it, and the
// two exports are narrowed to their real shapes just below.
import { SHARED_FILES, transform } from '../../scripts/sync-shared.mjs';

const ROOT = process.cwd();
const pairs = SHARED_FILES as Array<[string, string]>;
const applyTransform = transform as (source: string, destRel: string) => string;

describe('mobile/shared mirror', () => {
  it('has a non-empty file list', () => {
    // Guards the guard: an empty list would make every assertion below vacuous.
    expect(pairs.length).toBeGreaterThan(10);
  });

  for (const [srcRel, destRel] of pairs) {
    it(`${destRel} matches ${srcRel}`, () => {
      const srcPath = path.join(ROOT, srcRel);
      const destPath = path.join(ROOT, destRel);

      expect(existsSync(srcPath), `canonical source missing: ${srcRel}`).toBe(true);
      expect(
        existsSync(destPath),
        `mirror missing: ${destRel} — run \`npm run sync-shared\``
      ).toBe(true);

      const expected = applyTransform(readFileSync(srcPath, 'utf8'), destRel);
      const actual = readFileSync(destPath, 'utf8');

      expect(
        actual,
        `${destRel} has drifted from ${srcRel}.\n` +
          `Edit the canonical file in src/, then run \`npm run sync-shared\`.\n` +
          `Never hand-edit mobile/shared/ — the next sync silently discards it.`
      ).toBe(expected);
    });
  }
});
