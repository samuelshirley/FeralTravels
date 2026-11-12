import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * The /hotels proxy's shape (next.config.js). #108 shipped one rule,
 * `/hotels/:path*` → `…/hotels/:path*`: an empty `:path*` sent bare /hotels to
 * `…/hotels/`, the hotel finder answered `308 Location: /hotels`, and
 * production looped (2026-11-12, reproduced with curl against both hosts).
 * e2e/hotels-proxy.spec.ts proves the live behaviour on the preview; this
 * holds the rules so the loop cannot come back in a config edit.
 */
const require = createRequire(import.meta.url);
type Rewrite = { source: string; destination: string };
const nextConfig = require('../../next.config.js') as { rewrites: () => Promise<Rewrite[]> };

describe('the /hotels rewrite', () => {
  it('maps bare /hotels to bare /hotels — never to a trailing slash', async () => {
    const rules = (await nextConfig.rewrites()).filter((r) => r.source.startsWith('/hotels'));
    const bare = rules.find((r) => r.source === '/hotels');
    expect(bare, 'an exact /hotels rule').toBeDefined();
    expect(bare!.destination).toMatch(/^https:\/\/[^/]+\/hotels$/);
  });

  it('the catch-all needs at least one segment, so it can never catch bare /hotels', async () => {
    const rules = (await nextConfig.rewrites()).filter((r) => r.source.startsWith('/hotels'));
    for (const r of rules) {
      expect(r.source, r.source).not.toMatch(/:\w+\*/);
      expect(r.destination, r.destination).not.toMatch(/\/$/);
    }
    expect(rules.map((r) => r.source).sort()).toEqual(['/hotels', '/hotels/:path+']);
  });
});
