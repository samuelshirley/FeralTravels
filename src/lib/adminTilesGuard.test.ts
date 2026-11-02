import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROUTES, EXTERNAL_LINKS, buildAdminSections } from '@/app/admin/tiles';
import { dashboardFixture } from '@/test/adminDashboardFixture';

/**
 * The /admin homepage is a map of tiles, and four promises about it are
 * enforced here rather than remembered (Sam, 2026-11-02, launch day):
 *
 * 1. NO DEAD ENDS. Every tile opens a screen that exists. `tiles.ts` types
 *    `href` so a tile can only name a route in `ADMIN_ROUTES` or a URL in
 *    `EXTERNAL_LINKS`; this checks every one of those routes is a real
 *    `page.tsx`, and that every admin screen is reachable from a tile.
 * 2. ONLY TILES. The homepage renders the shell and the grid, nothing else —
 *    the panels it used to stack (tables, switches, forms) live on their own
 *    screens now, and a panel creeping back is the regression this catches.
 * 3. PROVIDER MONEY ONLY. The homepage imports no `usage_events` estimate.
 *    The tiles that used to sum our own rows undercounted the real bill.
 * 4. ONE TILE SIZE. Every tile is the same fixed box; text ellipsizes. No tile
 *    may carry a size of its own, by prop, by inline style or by CSS rule.
 */

const ROOT = join(__dirname, '..', '..');
const APP = join(ROOT, 'src/app');
const ADMIN = join(APP, 'admin');

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function adminPageDirs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) adminPageDirs(full, acc);
    else if (entry === 'page.tsx') acc.push('/' + relative(APP, dir).split('\\').join('/'));
  }
  return acc;
}

const allTiles = (d = dashboardFixture()) => buildAdminSections(d).flatMap((s) => s.tiles);

/** The fixture with every source failed or unconfigured — tiles must still link. */
const brokenFixture = () =>
  dashboardFixture({
    overview: { ok: false, error: 'x' },
    topSpender: { ok: false, error: 'x' },
    chat: { ok: false, error: 'x' },
    paywallOn: { ok: false, error: 'x' },
    promo: { ok: false, error: 'x' },
    anthropic: { status: 'not_configured', missing: ['ANTHROPIC_ADMIN_KEY'] },
    google: { status: 'error', message: 'x' },
    errors24h: { ok: false, error: 'x' },
    anthropicAlert: { ok: false, error: 'x' },
    penny: { ok: false, error: 'x' },
    jevMode: { ok: false, error: 'x' },
    announcements: { ok: false, error: 'x' },
  });

describe('1. no dead ends', () => {
  it('every ADMIN_ROUTES entry is a real page', () => {
    const missing = ADMIN_ROUTES.filter((r) => !existsSync(join(APP, r, 'page.tsx')));
    expect(missing, `ADMIN_ROUTES names routes with no page.tsx: ${missing.join(', ')}`).toEqual([]);
  });

  it('every static admin screen is in ADMIN_ROUTES — none is orphaned from the tile map', () => {
    const screens = adminPageDirs(ADMIN).filter((r) => r !== '/admin' && !r.includes('['));
    const orphans = screens.filter((r) => !(ADMIN_ROUTES as readonly string[]).includes(r));
    expect(orphans, `admin screens no tile can reach: ${orphans.join(', ')}`).toEqual([]);
  });

  for (const [name, fixture] of [
    ['healthy', dashboardFixture],
    ['every read failed', brokenFixture],
  ] as const) {
    it(`${name}: every tile links to an admin route or a known provider console`, () => {
      const externals = Object.values(EXTERNAL_LINKS) as string[];
      const bad = allTiles(fixture())
        .filter((t) => {
          if (externals.includes(t.href)) return false;
          const path = t.href.split('?')[0];
          return !(ADMIN_ROUTES as readonly string[]).includes(path);
        })
        .map((t) => `${t.id} → ${t.href}`);
      expect(bad).toEqual([]);
    });
  }

  it('every route in ADMIN_ROUTES is opened by at least one tile, and tile ids are unique', () => {
    const tiles = allTiles();
    const used = new Set(tiles.map((t) => t.href.split('?')[0]));
    expect(ADMIN_ROUTES.filter((r) => !used.has(r))).toEqual([]);
    const ids = tiles.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('2. the homepage is only tiles', () => {
  const page = stripComments(readFileSync(join(ADMIN, 'page.tsx'), 'utf8'));

  it('renders no element but the shell and the tile grid', () => {
    const tags = [...page.matchAll(/<([A-Za-z][\w.]*)[\s/>]/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(['AdminShell', 'AdminTileGrid']));
  });

  it('imports nothing local except the shell, the grid and the tile model', () => {
    const local = [...page.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((m) => m[1]).sort();
    expect(local).toEqual(['./AdminShell', './AdminTileGrid', './tiles']);
  });
});

describe('3. money on the homepage comes from the providers', () => {
  const page = stripComments(readFileSync(join(ADMIN, 'page.tsx'), 'utf8'));
  const tiles = stripComments(readFileSync(join(ADMIN, 'tiles.ts'), 'utf8'));

  it('the page reads Anthropic and Google through providerSpend', () => {
    expect(page).toMatch(/import \{[^}]*readAnthropicSpend[^}]*readGoogleSpend[^}]*\} from '@\/server\/providerSpend'/);
  });

  it('neither the page nor the tile model touches a usage_events estimate', () => {
    const ESTIMATES = [
      'getGlobalUsage',
      'getProviderTotals',
      'getGoogleBillableThisMonth',
      'microcentsToDollars',
      'getAllTimeAnthropicSpend',
      'estimateAnthropicCostUsd',
      '@/server/repos/usage',
    ];
    for (const src of [page, tiles]) for (const name of ESTIMATES) expect(src).not.toContain(name);
  });
});

describe('4. every tile is the same fixed size', () => {
  const css = stripComments(readFileSync(join(ADMIN, 'AdminTiles.module.css'), 'utf8'));
  const grid = stripComments(readFileSync(join(ADMIN, 'AdminTileGrid.tsx'), 'utf8'));
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()),
    body: m[2],
  }));
  const decl = (body: string, prop: string) => new RegExp(`(^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body)?.[2].trim();
  const SIZE_PROPS = /(^|[;\s])(width|height|min-width|max-width|min-height|max-height|padding[\w-]*|flex|flex-basis|flex-grow|flex-shrink|grid-column|grid-row|grid-area|aspect-ratio|zoom|box-sizing|inline-size|block-size)\s*:/;

  it('has no media / container / supports query that could resize anything', () => {
    expect(css).not.toMatch(/@(media|container|supports)/);
  });

  it('.tile is a fixed px box, and the grid tracks are exactly that box', () => {
    const tile = rules.find((r) => r.selectors.includes('.tile'));
    const gridRule = rules.find((r) => r.selectors.includes('.grid'));
    const w = decl(tile?.body ?? '', 'width');
    const h = decl(tile?.body ?? '', 'height');
    expect(w).toMatch(/^\d+px$/);
    expect(h).toMatch(/^\d+px$/);
    expect(decl(tile?.body ?? '', 'box-sizing')).toBe('border-box');
    expect(decl(tile?.body ?? '', 'overflow')).toBe('hidden');
    expect(decl(gridRule?.body ?? '', 'grid-template-columns')).toBe(`repeat(auto-fill, ${w})`);
    expect(decl(gridRule?.body ?? '', 'grid-auto-rows')).toBe(h);
    expect(tile?.body).not.toMatch(/(min|max)-(width|height)/);
  });

  it('no other rule that lands on the tile element sets a size', () => {
    const offenders = rules
      .filter((r) => !(r.selectors.length === 1 && r.selectors[0] === '.tile'))
      .filter((r) =>
        r.selectors.some((sel) => {
          const last = sel.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
          return /\.(tile|tone_\w+)\b/.test(last);
        })
      )
      .filter((r) => SIZE_PROPS.test(r.body))
      .map((r) => r.selectors.join(', '));
    expect(offenders, `rules that resize a tile: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('the component passes no inline style and uses one size class for every tile', () => {
    expect(grid).not.toMatch(/\bstyle\s*=/);
    expect(grid.match(/styles\.tile\b/g)).toHaveLength(1);
    expect(grid).toContain('const className = `${styles.tile} ${styles[`tone_${tile.tone}`]}`');
  });

  it('a tile carries no size of its own — the model has no size field', () => {
    const model = stripComments(readFileSync(join(ADMIN, 'tiles.ts'), 'utf8'));
    const iface = /export interface AdminTile \{([^}]*)\}/.exec(model)?.[1] ?? '';
    const keys = [...iface.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(['href', 'id', 'label', 'sub', 'tone', 'value']);
  });
});
