/**
 * Every Linux job runs on a PINNED image, never `ubuntu-latest`.
 *
 * 2026-11-02: GitHub began moving `ubuntu-latest` to ubuntu-26.04 mid-day.
 * Playwright 1.59.1 refuses to install Chromium there, so PR #95's E2E job
 * died before its first test while a run an hour earlier, on the same
 * workflow, got 24.04 and passed. A moving label is a CI result that changes
 * with no commit. Move the pin deliberately, with a Playwright that supports
 * the new image.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.join(process.cwd(), '.github', 'workflows');
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

function runsOn(source: string): string[] {
  return [...source.matchAll(/^\s*runs-on:\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

describe('workflow runners', () => {
  it('finds the workflows and their jobs', () => {
    expect(files.length).toBeGreaterThan(3);
    expect(files.flatMap((f) => runsOn(readFileSync(path.join(DIR, f), 'utf8'))).length).toBeGreaterThan(10);
  });

  it('no job runs on a moving -latest label', () => {
    const moving = files.flatMap((f) =>
      runsOn(readFileSync(path.join(DIR, f), 'utf8'))
        .filter((r) => /-latest\b/.test(r))
        .map((r) => `${f}: ${r}`),
    );
    expect(moving, 'pin the image (e.g. ubuntu-24.04) instead').toEqual([]);
  });
});
