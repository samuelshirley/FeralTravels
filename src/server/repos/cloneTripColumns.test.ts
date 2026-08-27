import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `cloneTrip` must copy every column, or say out loud which ones it doesn't.
 *
 * THREE separate bugs have now come from the same shape: a column added to the
 * schema, never added to `cloneTrip`'s insert, and a clone that looks right
 * until you use it.
 *
 *   - `legType` missing → every cloned rest day became a drive leg (text
 *     defaults to 'drive'), so a day titled "Porto (rest day)" offered a
 *     "Route to Destination — Porto" button to a driver standing in Porto.
 *     Read as a broken button.
 *   - `geometry` missing → no road-following route. The web draws straight
 *     lines between endpoints so it looked approximate; the native map draws
 *     only what it is given, so a cloned trip was scattered dots. Read as a
 *     broken map.
 *   - `fuelStatus` + `fuelStopsUpdatedAt` missing → every cloned leg looked
 *     never-sourced while holding sourced stops, so opening any day re-ran the
 *     full OSRM + Overpass + pricing search for stations already on screen.
 *     Read as slowness, then as an iOS bug. Invisible, because the stops that
 *     come back look like the stops that were there.
 *
 * None of those is findable by reading the clone — you have to use it, on the
 * one surface that happens to care. So the check is structural: every column in
 * `legs` and `stops` is either ASSIGNED in the corresponding insert, or listed
 * below with the reason it is deliberately left out. Adding a column and
 * forgetting the clone now fails the unit suite with the column's name in the
 * message.
 *
 * It parses source rather than executing anything, because `cloneTrip` needs a
 * database and this needs to run in the `unit` project with no environment at
 * all. That makes it a lint, not a proof: it cannot tell you the VALUE is
 * right, only that the column was considered.
 */

const ROOT = join(__dirname, '..', '..', '..');
const schemaSrc = readFileSync(join(ROOT, 'src/server/db/schema.ts'), 'utf8');
const reposSrc = readFileSync(join(ROOT, 'src/server/repos/trips.ts'), 'utf8');

/** Column keys declared on a drizzle `pgTable`, in declaration order. */
function schemaColumns(table: string): string[] {
  const start = schemaSrc.indexOf(`export const ${table} = pgTable(`);
  if (start === -1) throw new Error(`table ${table} not found in schema.ts`);
  // Up to the index/constraint callback, which is where the column block ends.
  const end = schemaSrc.indexOf('\n  (t)', start);
  const block = schemaSrc.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);
}

/** The keys assigned inside cloneTrip's `.insert(<table>).values({ ... })`. */
function clonedKeys(table: string): string[] {
  const fnStart = reposSrc.indexOf('export async function cloneTrip(');
  if (fnStart === -1) throw new Error('cloneTrip not found');
  const insertAt = reposSrc.indexOf(`.insert(${table})`, fnStart);
  if (insertAt === -1) throw new Error(`cloneTrip does not insert into ${table}`);
  const valuesAt = reposSrc.indexOf('.values({', insertAt);
  // Walk braces so a nested object or a comment brace cannot end the block early.
  let depth = 0;
  let i = reposSrc.indexOf('{', valuesAt);
  const from = i;
  for (; i < reposSrc.length; i++) {
    if (reposSrc[i] === '{') depth++;
    else if (reposSrc[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const block = reposSrc.slice(from, i + 1);
  // Strip block comments first — the explanatory ones contain `word:` shapes.
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/(?:^|[,{])\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)].map((m) => m[1]);
}

/**
 * Columns a clone must NOT carry, and why. Anything here is a decision; adding
 * a column to this list is how you record one.
 */
const OMITTED: Record<string, Record<string, string>> = {
  legs: {
    id: 'a new row gets a new id',
    tripId: 'assigned to the NEW trip, not copied',
    createdAt: 'the clone was created now',
    updatedAt: 'the clone was created now',
  },
  stops: {
    id: 'a new row gets a new id',
    legId: 'remapped through legIdMap to the cloned leg',
    createdAt: 'the clone was created now',
    updatedAt: 'the clone was created now',
    photos: 'dormant column — the stop-photos feature was removed 2026-06-30 and it is always null',
  },
};

describe('cloneTrip carries every column', () => {
  for (const table of ['legs', 'stops'] as const) {
    it(`${table}: no column is silently dropped`, () => {
      const declared = schemaColumns(table);
      expect(declared.length).toBeGreaterThan(5); // the parse found a real table

      const cloned = new Set(clonedKeys(table));
      const omitted = OMITTED[table];

      const unaccounted = declared.filter((c) => !cloned.has(c) && !(c in omitted));

      expect(
        unaccounted,
        `These ${table} columns are neither copied by cloneTrip nor listed as deliberately omitted:\n` +
          unaccounted.map((c) => `  - ${c}`).join('\n') +
          `\n\nA clone that drops a column does not look broken; it looks like a different bug on ` +
          `whichever screen happens to read it. Either copy the column in cloneTrip, or add it to ` +
          `OMITTED in this file with the reason.`
      ).toEqual([]);
    });

    it(`${table}: the omitted list has no stale entries`, () => {
      const declared = new Set(schemaColumns(table));
      const stale = Object.keys(OMITTED[table]).filter((c) => !declared.has(c));
      expect(stale, `OMITTED lists ${table} columns that no longer exist: ${stale.join(', ')}`).toEqual([]);
    });
  }

  /**
   * The specific regression, named. The structural check above would catch it,
   * but only as one entry in a list — and this pair is the reason the lazy fuel
   * design exists at all.
   */
  it('carries the fuel cache state, so a cloned day is not re-sourced on open', () => {
    const cloned = new Set(clonedKeys('legs'));
    expect(cloned.has('fuelStatus')).toBe(true);
    expect(cloned.has('fuelStopsUpdatedAt')).toBe(true);
  });

  it('carries legType and geometry, the two that cost a bug each', () => {
    const cloned = new Set(clonedKeys('legs'));
    expect(cloned.has('legType')).toBe(true);
    expect(cloned.has('geometry')).toBe(true);
  });
});
