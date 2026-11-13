import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `main` saves the compiled iOS simulator app under the SAME cache key every
 * PR's `ios-build` restores.
 *
 * Until 2026-11-13 every `ios-sim-app-*` cache entry was scoped to a PR's merge
 * ref, which no other PR can read, so the first run of every PR compiled for
 * 14-20 minutes with all five iOS shards waiting. `ios-app-cache.yml` now
 * builds on `main`. The way this quietly breaks is a drifted key: if either
 * caller computes it for itself, `main` saves under one key and PRs ask for
 * another, and a miss looks exactly like a slow runner. So the key is written
 * once, in the composite action, and both callers must go through it.
 */

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const action = read('.github/actions/ios-sim-app/action.yml');
const ci = read('.github/workflows/ci.yml');
const warm = read('.github/workflows/ios-app-cache.yml');

/** One top-level job's text out of a workflow (two-space-indented key). */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9_-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The `on:` block, up to the next top-level key. */
function triggers(workflow: string): string {
  const m = workflow.match(/\non:\n([\s\S]*?)\n(?=[a-z])/);
  if (!m) throw new Error('no on: block');
  return m[1];
}

const USES_ACTION = /uses: \.\/\.github\/actions\/ios-sim-app\s*\n/;
const KEY_PREFIX = 'ios-sim-app-v1-';

describe('the iOS app cache key has one definition, and main fills it', () => {
  it('the composite action defines the key and saves on a miss', () => {
    expect(action).toContain(KEY_PREFIX);
    // actions/cache saves in its post step; cache/restore never would.
    expect(action).toMatch(/uses: actions\/cache@v\d+\n\s+with:\n\s+path: mobile\/ios-build\n\s+key: \$\{\{ steps\.fp\.outputs\.key \}\}/);
    expect(action).not.toMatch(/actions\/cache\/restore@/);
  });

  it("ci.yml's ios-build goes through the action and does not compute a key of its own", () => {
    const build = job(ci, 'ios-build');
    expect(build).toMatch(USES_ACTION);
    expect(ci).not.toContain(KEY_PREFIX);
    expect(ci).not.toMatch(/fingerprint:generate/);
  });

  it('ios-app-cache.yml goes through the same action and does not compute a key of its own', () => {
    expect(warm).toMatch(USES_ACTION);
    expect(warm).not.toContain(KEY_PREFIX);
    expect(warm).not.toMatch(/fingerprint:generate/);
  });

  it('ios-app-cache.yml runs on main — never on a pull_request, whose save no other PR can read', () => {
    const on = triggers(warm);
    expect(on).toMatch(/\n?\s*push:\n\s+branches: \[main\]/);
    expect(on).toMatch(/\bschedule:/);
    expect(on).not.toMatch(/pull_request/);
  });

  it('both callers run on the same runner label, since the image is part of the key', () => {
    const label = (s: string) => s.match(/runs-on: (\S+)/)?.[1];
    expect(label(warm)).toBe(label(job(ci, 'ios-build')));
  });
});
