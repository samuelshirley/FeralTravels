import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every `.github/workflows/<name>.yml` the docs and scripts name is a real file.
 *
 * A consolidation of the five workflows into one `pipeline.yml` was written on
 * 2026-09-11 — `pipeline.yml.new` plus a `spring-clean.sh` to install it — and
 * never run. The docs were updated to describe it anyway: CLAUDE.md, README,
 * `deploy-pipeline.md`, `mobile-release.md` and two CI error messages in
 * `assert-e2e-ran.mjs` all pointed at a file that did not exist, for ten days,
 * while the repo ran on `ci.yml` and four others. The one place that noticed,
 * `testflight-and-apple-setup.md`, noticed by hand. (The drafts were deleted
 * 2026-09-21.)
 *
 * A SET RELATION between two artifacts — the paths named in text, and the files
 * in `.github/workflows/` — so rewording cannot defeat it and a rename trips it
 * on the day it happens, in whichever direction the drift runs.
 *
 * TOMBSTONES ARE ALLOWED, on the rule `claudeMdGuard` applies to `scripts/`:
 * a mention within 200 characters of GONE / deleted / removed / does not exist
 * / no longer / "there is no `name`" is a sentence saying the file is gone, and
 * that sentence is what stops someone recreating it. The last is the one
 * addition — `testflight-and-apple-setup.md` corrects the record with exactly
 * that phrase — and it needs the backtick: bare "there is no" excused a
 * re-introduced `pipeline.yml` in README because "There is no ship script" sat
 * two lines above it. The mutation check caught that. A document whose status
 * header says SUPERSEDED is a tombstone as a whole — it is kept for design
 * history, and rewriting history to satisfy a guard is the wrong fix.
 */

const ROOT = join(__dirname, '..', '..');
const TOMBSTONE = /\bGONE\b|deleted|removed|does not exist|no longer|there is no\s+`/i;
const WORKFLOW_REF = /\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)/g;

/** Tracked and untracked-but-not-ignored text files the rule covers. */
function scannedFiles(): string[] {
  return execSync('git ls-files --cached --others --exclude-standard', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(md|mjs|sh)$/.test(f));
}

/** Workflow files named in `text` without a tombstone nearby. */
export function ghostWorkflows(text: string, real: ReadonlySet<string>): string[] {
  if (/^\*\*Status:\*\*\s*SUPERSEDED\b/m.test(text.slice(0, 1000))) return [];
  const ghosts: string[] = [];
  for (const m of text.matchAll(WORKFLOW_REF)) {
    if (real.has(m[1])) continue;
    const around = text.slice(Math.max(0, m.index - 200), m.index + 200);
    if (TOMBSTONE.test(around)) continue;
    ghosts.push(m[1]);
  }
  return ghosts;
}

describe('every .github/workflows/*.yml named in docs and scripts exists', () => {
  const real = new Set(readdirSync(join(ROOT, '.github', 'workflows')));

  it('finds the workflows and the files that name them (the guard is not vacuous)', () => {
    expect(real.has('ci.yml')).toBe(true);
    const files = scannedFiles();
    expect(files).toContain('CLAUDE.md');
    expect(files).toContain('README.md');
    expect(files.some((f) => f.endsWith('.mjs'))).toBe(true);
  });

  it('names no workflow that is not on disk', () => {
    const ghosts: string[] = [];
    for (const f of scannedFiles()) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue; // listed by git but deleted in the working tree
      }
      for (const g of ghostWorkflows(text, real)) ghosts.push(`${f}: .github/workflows/${g}`);
    }
    expect(
      ghosts,
      'These name a workflow file that does not exist. Point them at the real one, or say it is gone.',
    ).toEqual([]);
  });

  it('a tombstone excuses a mention; a bare mention does not', () => {
    const real = new Set(['ci.yml']);
    expect(ghostWorkflows('Runs in `.github/workflows/pipeline.yml`.', real)).toEqual(['pipeline.yml']);
    expect(ghostWorkflows('`.github/workflows/pipeline.yml` does not exist.', real)).toEqual([]);
    expect(ghostWorkflows('See `.github/workflows/ci.yml`.', real)).toEqual([]);
    expect(ghostWorkflows('There is no\n`pipeline.yml` — `.github/workflows/pipeline.yml`', real)).toEqual([]);
    // "There is no" about something ELSE is not a tombstone for the file.
    expect(
      ghostWorkflows('There is no ship script.\n\nRuns in `.github/workflows/pipeline.yml`.', real),
    ).toEqual(['pipeline.yml']);
    expect(
      ghostWorkflows('# Old plan\n\n**Status:** SUPERSEDED — kept for history.\n\n' + 'x'.repeat(500) + '\n`.github/workflows/deploy.yml`', real),
    ).toEqual([]);
  });
});
