import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No PGlite test pays the database boot inside its own 5 s budget.
 *
 * `testDb()` boots lazily, so before 2026-10-21 a pg test file with no hook
 * booted Postgres and replayed the whole schema inside its first test — ~3.5 s
 * alone, over 5 s on a loaded runner. PR 90's CI failed on
 * `schema.test.ts > has every table and no other` at 5171 ms with no code
 * change. The pg project's setup file now boots in a `beforeAll` with its own
 * timeout; this keeps it wired.
 */
const ROOT = join(__dirname, '..', '..');

describe('the pg project boots its database in a hook, never in a test', () => {
  it('the pg project lists src/test/pg/setup.ts as a setup file', () => {
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    const pgProject = config.slice(config.indexOf("name: 'pg'"));
    const block = pgProject.slice(0, pgProject.indexOf('},'));
    expect(block).toMatch(/setupFiles:\s*\[[^\]]*'\.\/src\/test\/pg\/setup\.ts'/);
  });

  it('setup.ts awaits testDb() in a beforeAll with a timeout longer than a test', () => {
    const setup = readFileSync(join(ROOT, 'src/test/pg/setup.ts'), 'utf8');
    const m = setup.match(/beforeAll\(\s*async\s*\(\)\s*=>\s*\{\s*await testDb\(\);\s*\},\s*([\d_]+)\s*\)/);
    expect(m, 'beforeAll(async () => { await testDb(); }, <timeout>)').not.toBeNull();
    expect(Number(m![1].replace(/_/g, ''))).toBeGreaterThan(5_000);
  });
});
