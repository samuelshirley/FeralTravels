import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A seeded planned trip carries the chat a real one has.
 *
 * A trip a person planned always has the conversation that planned it, so it
 * never opens on Penny's "START HERE" empty state. Seeders that wrote legs and
 * no chat produced exactly that screen, which no real user reaches — Sam's
 * "Ordesa Notes Check" opened on suggestion chips above a finished itinerary.
 * `writeSeededTranscript` (src/server/seededTranscript.ts) writes the real
 * onboarding → handoff → plan transcript; this guard makes forgetting it a red
 * unit run instead of a confused tester.
 *
 * THE RULE: every function in a seeder file that writes legs calls
 * `writeSeededTranscript(`, after its last leg write (the writer reads the legs
 * back to compute the plan summary). "Writes legs" is `addLeg(`,
 * `insert(legs)` or `cloneTrip(`.
 *
 * Why "writes legs" alone and not "writes legs AND marks the trip onboarded":
 * a seeder that writes legs and leaves the trip in onboarding builds the
 * incoherent trip `impossibleFixtureTripReason` exists to refuse, so there is
 * no legitimate leg-writing seeder the transcript rule would wrongly catch —
 * and matching every way a trip gets marked `done` (a literal, a spread of
 * `CANONICAL_TRIP_META`, a helper) would be a regex that goes quietly blind.
 *
 * WHICH FILES ARE SEEDERS — self-completing, not a list. Any non-test file under
 * `src/` that references a fixture gate (`assertEnabled`, `isFixtureEmail`,
 * `areTestEndpointsEnabled`, `assertNotProduction`, `testAccountsAvailable`) and
 * writes legs is in scope, so a new seeder file cannot slip past by not being
 * named here.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

const FIXTURE_GATE = /\b(assertEnabled|isFixtureEmail|areTestEndpointsEnabled|assertNotProduction|testAccountsAvailable)\b/;
const LEG_WRITE = /\baddLeg\(|\binsert\(legs\)|\bcloneTrip\(/g;
const TRANSCRIPT_CALL = /\bwriteSeededTranscript\(/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/**
 * Comments removed, so a doc comment naming `writeSeededTranscript(` cannot
 * satisfy the rule for the function below it. Line comments only where `//` is
 * not part of a URL in a string.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}()])\/\/.*$/gm, '$1');
}

/** Top-level function declarations (and `const x = async (…) =>`), each with its body. */
function topLevelFunctions(src: string): Array<{ name: string; body: string }> {
  const starts = [
    ...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm),
  ];
  return starts.map((m, i) => ({
    name: m[1] ?? m[2],
    body: src.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : src.length),
  }));
}

function lastIndex(body: string, re: RegExp): number {
  let at = -1;
  for (const m of body.matchAll(re)) at = m.index ?? at;
  return at;
}

const seederFiles = walk(SRC)
  .map((path) => ({ path, rel: relative(ROOT, path), src: stripComments(readFileSync(path, 'utf8')) }))
  .filter((f) => FIXTURE_GATE.test(f.src) && new RegExp(LEG_WRITE.source).test(f.src));

describe('seeded planned trips carry a transcript', () => {
  it('finds the seeders it is meant to police (a scan that finds nothing proves nothing)', () => {
    const rels = seederFiles.map((f) => f.rel);
    expect(rels).toContain('src/server/repos/testSupport.ts');
    expect(rels).toContain('src/server/payments/testAccounts.ts');
  });

  it('finds the leg-writing seeders by name', () => {
    const writers = seederFiles.flatMap((f) =>
      topLevelFunctions(f.src)
        .filter((fn) => new RegExp(LEG_WRITE.source).test(fn.body))
        .map((fn) => fn.name),
    );
    expect(writers).toEqual(expect.arrayContaining(['seedFixture', 'seedCanonicalTrip', 'seedRealisticAccountData']));
  });

  it('every function that writes legs writes the transcript, after its last leg', () => {
    const offenders: string[] = [];
    for (const f of seederFiles) {
      for (const fn of topLevelFunctions(f.src)) {
        const lastLeg = lastIndex(fn.body, LEG_WRITE);
        if (lastLeg < 0) continue;
        const lastTranscript = lastIndex(fn.body, TRANSCRIPT_CALL);
        if (lastTranscript < 0) {
          offenders.push(`${f.rel} ${fn.name}(): writes legs but never calls writeSeededTranscript()`);
        } else if (lastTranscript < lastLeg) {
          offenders.push(`${f.rel} ${fn.name}(): calls writeSeededTranscript() before its last leg write`);
        }
      }
    }
    expect(
      offenders,
      'A seeded trip with legs and no chat opens on Penny\'s START HERE screen, which no real ' +
        'planned trip shows. Call writeSeededTranscript(tripId) once the legs, vehicle and pace ' +
        'are on the trip — see src/server/seededTranscript.ts.',
    ).toEqual([]);
  });
});
