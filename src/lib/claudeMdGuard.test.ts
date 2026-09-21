import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * CLAUDE.md's index lists are complete, and checked by machine.
 *
 * CLAUDE.md exists so an assistant can orient without reading the codebase, and
 * it is therefore RELIED ON as fact. That is exactly what makes it dangerous
 * when it drifts: `a0c9ee6` moved Finn from OSM/OSRM to Google Places on
 * 2026-07-22, CLAUDE.md kept saying OSM "for free" for seven weeks, and an
 * assistant read it, relayed it as fact, built a fuel cascade on the belief that
 * the calls were free, and wrote the false rationale back into the file.
 *
 * Prose cannot defend itself, and most of CLAUDE.md is prose that only a reader
 * can check — which is what the docs-drift PR reviewer is for. The INDEX LISTS
 * are the deterministic half: they are just sets of paths, so a machine can
 * check them, and it should, because an index nobody can trust is worse than no
 * index at all — the reader cannot tell "not listed" from "does not exist".
 * Fourteen scripts were missing from it when this was written.
 */

const ROOT = join(__dirname, '..', '..');
const claudeMd = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

/** Everything in scripts/ that is a script (not the shared `lib/` folder). */
function scriptNames(): string[] {
  return readdirSync(join(ROOT, 'scripts'))
    .filter((n) => n !== 'lib' && !n.startsWith('.'))
    .filter((n) => statSync(join(ROOT, 'scripts', n)).isFile());
}

/** Every API route path, as CLAUDE.md writes them (`api/foo/[id]`). */
function routePaths(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routePaths(p, out);
    else if (name === 'route.ts') {
      out.push('api/' + relative(join(ROOT, 'src/app/api'), dir).split('\\').join('/'));
    }
  }
  return out;
}

describe('CLAUDE.md lists what exists', () => {
  it('names every script', () => {
    const missing = scriptNames().filter((n) => !claudeMd.includes(n));
    expect(missing, 'Add these to the Scripts section — that list is read as authoritative.')
      .toEqual([]);
  });

  it('names every API route', () => {
    const missing = routePaths(join(ROOT, 'src/app/api')).filter((r) => !claudeMd.includes(r));
    expect(missing, 'Add these to the API Routes section.').toEqual([]);
  });
});

describe('CLAUDE.md names nothing that has been deleted', () => {
  /** Paths CLAUDE.md claims exist, in the two index lists' shapes. */
  it('every scripts/<name> it mentions is a real file, or is named as deleted', () => {
    // A TOMBSTONE is legitimate and valuable: "scripts/ship.sh and npm run ship
    // are GONE (deleted 2026-08-14) — the script pushed straight to prod outside
    // every gate" is exactly the sentence that stops someone recreating it. What
    // must not exist is a mention that reads as though the file is still there.
    const real = new Set(scriptNames());
    const ghosts: string[] = [];
    for (const m of claudeMd.matchAll(/`?scripts\/([A-Za-z0-9._-]+)`?/g)) {
      const name = m[1];
      if (name === 'lib' || real.has(name)) continue;
      const around = claudeMd.slice(Math.max(0, m.index - 200), m.index + 200);
      if (/\bGONE\b|deleted|removed|no longer exists/i.test(around)) continue;
      ghosts.push(name);
    }
    expect(
      [...new Set(ghosts)],
      'CLAUDE.md names scripts that do not exist, without saying they were removed.',
    ).toEqual([]);
  });

  it('every api/<path> it mentions is a real route, or is named as deleted', () => {
    // The mirror of "names every API route" above, which only ever checked one
    // direction: a route that exists must be listed. Nothing checked that a
    // listed route exists, and `api/directions` sat in the index from July
    // until 2026-09-20 after its route.ts was deleted. `api/test/*` is a
    // prefix and passes if any route lives under it.
    const real = new Set(routePaths(join(ROOT, 'src/app/api')));
    const ghosts: string[] = [];
    for (const m of claudeMd.matchAll(/\bapi\/[A-Za-z0-9_.*[\]/-]+/g)) {
      const named = m[0].replace(/[./]+$/, '');
      if (named.endsWith('/*')) {
        const prefix = named.slice(0, -1);
        if ([...real].some((r) => r.startsWith(prefix))) continue;
      } else if (real.has(named)) continue;
      const around = claudeMd.slice(Math.max(0, m.index - 200), m.index + 200);
      if (/\bGONE\b|deleted|removed|does not exist|no longer|there is no\s+`/i.test(around)) continue;
      ghosts.push(named);
    }
    expect(
      [...new Set(ghosts)],
      'CLAUDE.md names API routes that do not exist, without saying they were removed.',
    ).toEqual([]);
  });
});

describe('CLAUDE.md size', () => {
  const LIMIT_BYTES = 28 * 1024;
  const bytes = Buffer.byteLength(claudeMd, 'utf8');

  /**
   * UN-SKIPPED 2026-09-20, when the cleanup landed: 225 KB -> ~20 KB. Every
   * section that was prose is now one sentence and a link into `docs/`, and
   * nothing was deleted — see the table at the end of CLAUDE.md.
   *
   * ── The limit was RAISED to 28 KB the same day, and that is not the raise
   *    the previous version of this comment forbade ─────────────────────────
   *
   * What it forbade was raising the number INSTEAD of doing the cleanup —
   * setting the limit to whatever the file happens to weigh today, which is a
   * guard switched off while still looking green. The cleanup has happened:
   * 225 KB of narrative moved into `docs/design/` and the file came back at
   * 20,300 bytes.
   *
   * The problem with 20 KB is that it left 180 bytes of headroom against a
   * guard that MANDATES growth. The two tests above require every API route
   * and every file in `scripts/` to be named here, so adding one route — a
   * ~25-byte doc line the guard itself demands — would have turned CI red on
   * the index rather than on the code. A ceiling that fails on the change it
   * requires is not a ceiling, it is a trap, and the predictable response is
   * someone raising the number in a hurry with no reasoning attached. 28 KB is
   * ~8 KB of room: enough for a few hundred index entries, still far too
   * little to re-absorb a section of prose.
   *
   * The rule is unchanged in the direction that matters: if a change pushes
   * the file over, the fix is to move PROSE into the topic file under
   * `docs/design/` and leave one line behind. Raise this number only for
   * content the guard compels, and say so in the commit.
   *
   * BETTER FIX, deliberately not done here: move the index lists themselves
   * into a doc the assistant reads first, so CLAUDE.md stops carrying ~5 KB of
   * machine-checked names at all and this tension disappears. That is a change
   * to what the file IS, and it belongs in its own PR rather than riding along
   * with a budget bump.
   */
  it(`is under ${LIMIT_BYTES / 1024} KB`, () => {
    expect(bytes).toBeLessThanOrEqual(LIMIT_BYTES);
  });
});
