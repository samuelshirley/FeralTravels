import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Vercel's own git auto-deploy stays OFF. Decision F6.
 *
 * GitHub Actions owns every deployment. Leaving Vercel's git integration on
 * would produce a SECOND, untested preview per PR — wired to whatever
 * `DATABASE_URL` happens to sit in the Vercel Preview environment rather than
 * to the PR's own ephemeral Neon branch — and a second production deploy that
 * never passes the CI gate.
 */

const cfg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8')) as {
  git?: { deploymentEnabled?: unknown };
};

describe('vercel.json', () => {
  it('disables git-triggered deployments', () => {
    // `false` (all branches) or a per-branch map with every value false.
    const v = cfg.git?.deploymentEnabled;
    if (typeof v === 'object' && v !== null) {
      expect(Object.values(v as Record<string, unknown>).every((b) => b === false)).toBe(true);
    } else {
      expect(v).toBe(false);
    }
  });
});
