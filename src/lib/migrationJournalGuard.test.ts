import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A migration file drizzle's journal does not list DOES NOT RUN, and nothing
 * anywhere says so.
 *
 * THE BUG THIS EXISTS FOR, 2026-09-09. Four migrations (0036–0039) were written
 * by hand rather than by `npm run db:generate`, which writes the `.sql` AND the
 * journal entry. The files were committed, `db:migrate` reported success having
 * applied none of them, the CI preview deployed green, and then thirty-nine E2E
 * specs died on `column "penny_strikes" of relation "users" does not exist`.
 *
 * Every signal on the way was reassuring: the SQL was correct, `tsc` passed,
 * 1,496 unit tests passed, and the migration step's own log said "Migrations
 * complete." The migrator reads `meta/_journal.json` and runs what IT lists —
 * a file on disk that is not in it is invisible, silently and by design.
 *
 * So the property is checked directly: the two lists agree, both ways.
 */

const DIR = join(__dirname, '..', '..', 'drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function journal(): JournalEntry[] {
  const raw = readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function sqlTags(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

/**
 * No orphans are tolerated. The list is empty and should stay that way.
 *
 * Three files USED to be here — `0003_add_rest_days_and_leg_type`,
 * `0004_rename_water_to_dump_station`, `0005_add_pending_intent` — found by the
 * first run of this guard, predating the journal and never executed anywhere.
 * They were pinned as known-orphans at first, on the reasoning that journaling
 * them would run a rename into a feature migration 0015 deleted outright.
 *
 * `test/enforce-decisions-register` reached the same three independently and
 * DELETED them, which is strictly better and is what shipped: a pin leaves the
 * files sitting there inviting the next person to "repair the chain", and the
 * only thing they could repair it into is a fight with 0014/0015's drops.
 * Keeping the list empty is what makes this guard say what it means.
 */
const KNOWN_ORPHANS: string[] = [];

describe('the drizzle migration journal', () => {
  it('lists every .sql file in the folder', () => {
    const listed = new Set(journal().map((e) => e.tag));
    const orphans = sqlTags().filter((t) => !listed.has(t));
    expect(
      orphans,
      'these migrations exist on disk and will NEVER run — add them to drizzle/meta/_journal.json, or generate them with `npm run db:generate`'
    ).toEqual(KNOWN_ORPHANS);
  });

  it('has a .sql file for every entry it lists', () => {
    const onDisk = new Set(sqlTags());
    const missing = journal()
      .map((e) => e.tag)
      .filter((t) => !onDisk.has(t));
    expect(missing, 'the journal names migrations that do not exist').toEqual([]);
  });

  it('is ordered, with no duplicate index and no duplicate tag', () => {
    // `idx` is the order the migrator applies them in; `when` is what it
    // compares against the `__drizzle_migrations` table to decide what is
    // already applied. Either one going backwards reorders or re-runs history.
    const entries = journal();
    const idxs = entries.map((e) => e.idx);
    const tags = entries.map((e) => e.tag);
    expect(new Set(idxs).size, 'duplicate idx').toBe(idxs.length);
    expect(new Set(tags).size, 'duplicate tag').toBe(tags.length);
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
    const whens = entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b), 'timestamps must increase').toEqual(whens);
  });

  it('applies the files in filename order', () => {
    /*
     * The filename prefix is documentation, not the mechanism — the migrator
     * never reads it, it reads `when`. So the prefixes cannot be required to
     * EQUAL the index (three legacy orphans above already offset them), but
     * they must not go backwards: a file numbered 0040 applying before one
     * numbered 0038 would run in an order no reader of the folder expects.
     */
    const prefixes = journal().map((e) => Number(e.tag.slice(0, 4)));
    const sorted = [...prefixes].sort((a, b) => a - b);
    expect(prefixes, 'the journal applies migrations out of filename order').toEqual(sorted);
  });
});
