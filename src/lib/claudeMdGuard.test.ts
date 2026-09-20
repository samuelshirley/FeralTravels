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
});

describe('CLAUDE.md size', () => {
  const LIMIT_BYTES = 20 * 1024;
  const bytes = Buffer.byteLength(claudeMd, 'utf8');

  /**
   * UN-SKIPPED 2026-09-20, when the cleanup landed: 225 KB -> ~20 KB. Every
   * section that was prose is now one sentence and a link into `docs/`, and
   * nothing was deleted — see the table at the end of CLAUDE.md.
   *
   * The limit is 20 KB and it does not move. If a change pushes the file over,
   * the fix is to move prose into the topic file under `docs/design/` and leave
   * one line behind; a limit quietly raised to whatever the file happens to
   * weigh today is a guard switched off while still looking green.
   *
   * The margin is deliberately small but real (a few hundred bytes), so adding
   * an index entry — a new route, a new script — does not fail the build, while
   * adding a paragraph does. That is the intended shape.
   */
  it(`is under ${LIMIT_BYTES / 1024} KB`, () => {
    expect(bytes).toBeLessThanOrEqual(LIMIT_BYTES);
  });
});
