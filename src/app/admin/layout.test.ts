import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The admin layout keeps sending a signed-out visitor to the sign-in form.
 *
 * Found 2026-09-30: with the web off, /admin redirected a signed-out admin to
 * /get-the-app, which has no sign-in — the one person allowed in had no door.
 * The layout is the whole fix, and it is three lines that look like
 * boilerplate. Delete the call and every admin page falls back to its own
 * `requireWebAccess()`, which is the download screen again, with every other
 * test still green.
 *
 * Reads the source, as `webAccessCoverage.test.ts` does for the pages.
 */
const body = readFileSync(join(__dirname, 'layout.tsx'), 'utf8');
const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('admin layout', () => {
  it('awaits requireAdminSignIn() before rendering its children', () => {
    const gate = code.indexOf('await requireAdminSignIn()');
    expect(gate, 'src/app/admin/layout.tsx no longer awaits requireAdminSignIn()').toBeGreaterThan(-1);
    expect(code.indexOf('return children')).toBeGreaterThan(gate);
  });

  it('is never statically rendered — the answer depends on the request cookie', () => {
    expect(code).toContain("export const dynamic = 'force-dynamic'");
  });
});
