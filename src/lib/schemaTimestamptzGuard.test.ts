import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every timestamp column carries its time zone. Decisions D8 and G5.
 *
 * Postgres stores a `timestamp` (no zone) as a bare wall-clock reading and
 * drizzle reads it back as if it were UTC. Those agree only when the database
 * itself runs in UTC — which Neon does, so production and CI are correct and
 * the defect is invisible exactly where anyone would look for it.
 *
 * It was not theoretical: `email_otp_codes.created_at` was such a column, so
 * `getExistingOtpAgeMs` returned a NEGATIVE age on a non-UTC database, the
 * 60-second resend cooldown never expired, and every resend was a 429 forever —
 * a user who never received their sign-in email could never ask for another.
 * Migration 0032 converted all 43.
 *
 * This guard caught the forty-fourth: `user_viewport_time.updated_at` was
 * converted in the DATABASE by 0032 but left as a bare `timestamp(` in
 * `schema.ts`, so the code and the column disagreed about the type.
 */

const SCHEMA = join(__dirname, '..', 'server', 'db', 'schema.ts');
const src = readFileSync(SCHEMA, 'utf8');

/**
 * A `timestamp(...)` column declaration and everything up to the closing paren
 * of its options object. Drizzle's builder allows the options on the same call,
 * possibly across lines.
 */
function timestampDeclarations(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!/\btimestamp\s*\(/.test(line)) return;
    // Take this line plus the next two, so a multi-line options object is seen.
    out.push({ line: i + 1, text: [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join('\n') });
  });
  return out;
}

describe('schema.ts uses timestamptz everywhere', () => {
  it('finds the timestamp columns', () => {
    expect(timestampDeclarations(src).length).toBeGreaterThan(30);
  });

  it('no timestamp column omits withTimezone', () => {
    const bad = timestampDeclarations(src)
      .filter((d) => !/withTimezone:\s*true/.test(d.text))
      .map((d) => `schema.ts:${d.line}: ${d.text.split('\n')[0].trim().slice(0, 90)}`);
    expect(
      bad,
      'A timestamp without a zone is only correct while the database runs in UTC. ' +
        'Declare it { withTimezone: true }.',
    ).toEqual([]);
  });
});
