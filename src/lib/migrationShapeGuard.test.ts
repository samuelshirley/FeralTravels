import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Migrations are additive unless the filename says otherwise. Decision G4.
 *
 * Merging a PR IS the deploy, and the deploy applies migrations to production
 * before the new code is live. The uncovered window is: migrate succeeds →
 * deploy fails → production runs OLD code against a NEW schema. An ADDITIVE
 * migration makes that window harmless; a `DROP COLUMN` makes it an outage.
 *
 * The rule is not "never drop" — it is "add → backfill → switch code → drop
 * later", and the later drop is a deliberate act. So a destructive migration is
 * allowed, and must say so in its FILENAME, where it is greppable and visible in
 * the PR's file list rather than buried on line 40 of a .sql file.
 */

const DIR = join(__dirname, '..', '..', 'drizzle');
const DESTRUCTIVE = /\b(DROP\s+COLUMN|DROP\s+TABLE)\b/i;

const files = readdirSync(DIR)
  .filter((n) => n.endsWith('.sql'))
  .sort();

describe('migration shape', () => {
  it('there are migrations to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('the NEWEST migration is additive, or is named as a drop', () => {
    // Only the newest: the older ones are history and cannot be changed, and
    // rewriting the rule for them would mean editing applied migrations.
    const newest = files[files.length - 1];
    const sql = readFileSync(join(DIR, newest), 'utf8');
    if (!DESTRUCTIVE.test(sql)) return;
    expect(
      /drop/i.test(newest),
      `${newest} drops a column or table but its name does not say so. Rename it ` +
        `so the destructive step is visible in the PR's file list, and make sure the ` +
        `code that stopped using it shipped in an EARLIER deploy.`,
    ).toBe(true);
  });

  it('every migration is recorded in the journal', () => {
    // A .sql file the journal does not list never runs, which is a silent
    // no-op rather than an error — the worst shape a migration can have.
    const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const tags = new Set(journal.entries.map((e) => e.tag));
    const orphans = files.map((f) => f.replace(/\.sql$/, '')).filter((t) => !tags.has(t));
    expect(orphans, 'These .sql files are not in _journal.json, so they never run.').toEqual([]);
  });
});
