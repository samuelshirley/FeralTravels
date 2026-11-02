import { describe, expect, it, vi } from 'vitest';
import { buildAdminSections, fmtAgo, fmtUsd, missingVars, settle, type AdminTile } from './tiles';
import { dashboardFixture, NOW } from '@/test/adminDashboardFixture';

/**
 * The /admin tile map, built from fixtures. What each tile says in each state
 * of its source — ok, failed, unconfigured — and the order Sam asked for.
 */

function tileById(id: string, d = dashboardFixture()): AdminTile {
  const t = buildAdminSections(d)
    .flatMap((s) => s.tiles)
    .find((x) => x.id === id);
  if (!t) throw new Error(`no tile ${id}`);
  return t;
}

describe('layout', () => {
  it('sections run Growth, Users, Money, Cost, Health, Comms, Tools', () => {
    expect(buildAdminSections(dashboardFixture()).map((s) => s.title)).toEqual([
      'Growth',
      'Users',
      'Money',
      'Cost',
      'Health',
      'Comms',
      'Tools',
    ]);
  });

  it('new signups is the very first tile, showing 24 h with 7 d beside it', () => {
    const first = buildAdminSections(dashboardFixture())[0].tiles[0];
    expect(first).toMatchObject({ id: 'new-signups', value: '12', sub: '61 in 7d', href: '/admin/signups', tone: 'good' });
  });

  it('the removed tiles stay removed', () => {
    const labels = buildAdminSections(dashboardFixture()).flatMap((s) => s.tiles.map((t) => t.label.toLowerCase()));
    for (const gone of ['chat messages', 'ai spend (all-time)', 'all-time', 'spend by provider']) {
      expect(labels.some((l) => l.includes(gone))).toBe(false);
    }
  });

  it('Top spenders is one tile in Users, opening the users list sorted by spend', () => {
    const users = buildAdminSections(dashboardFixture()).find((s) => s.id === 'users');
    const t = users?.tiles.find((x) => x.id === 'top-spenders');
    expect(t).toMatchObject({ value: 'Big Spender', href: '/admin/users?sort=spend_desc' });
    expect(t?.sub).toBe('$8.12 all time · list-price est.');
  });
});

describe('AI spend — Anthropic-sourced only', () => {
  it('ok: today, 7 days and the projection are Anthropic’s figures, labelled with their exact windows', () => {
    expect(tileById('ai-spend-today')).toMatchObject({
      label: 'AI spend · today UTC',
      value: '$2.34',
      sub: 'Anthropic-billed · yesterday $1.10',
      href: 'https://platform.claude.com/cost',
    });
    expect(tileById('ai-spend-7d')).toMatchObject({ label: 'AI spend · 7 UTC days', value: '$8.40' });
    expect(tileById('projected-month')).toMatchObject({ value: '$33.00', href: '/admin/cost' });
  });

  it('unconfigured: all three say so and name the variable — no number from anywhere else', () => {
    const d = dashboardFixture({ anthropic: { status: 'not_configured', missing: ['ANTHROPIC_ADMIN_KEY'] } });
    for (const id of ['ai-spend-today', 'ai-spend-7d', 'projected-month']) {
      expect(tileById(id, d)).toMatchObject({ value: 'Not configured', sub: 'set ANTHROPIC_ADMIN_KEY', tone: 'muted' });
    }
  });

  it('error: the provider’s message is the sub-line', () => {
    const d = dashboardFixture({ anthropic: { status: 'error', message: 'Anthropic cost_report HTTP 503: boom' } });
    expect(tileById('ai-spend-today', d)).toMatchObject({
      value: 'Error',
      sub: 'Anthropic cost_report HTTP 503: boom',
      tone: 'danger',
      href: 'https://platform.claude.com/cost',
    });
  });
});

describe('Google — billing-export-sourced only', () => {
  it('ok: net month to date in the billing account’s own currency', () => {
    expect(tileById('google-billable')).toMatchObject({
      label: 'Google · this month',
      value: '€10.25',
      href: 'https://console.cloud.google.com/billing/reports',
    });
  });

  it('unconfigured: says so, names both variables, still opens the billing reports page', () => {
    const d = dashboardFixture({
      google: { status: 'not_configured', missing: ['GOOGLE_BILLING_SA_KEY_JSON', 'GOOGLE_BILLING_EXPORT_TABLE'] },
    });
    expect(tileById('google-billable', d)).toMatchObject({
      value: 'Not configured',
      sub: 'set GOOGLE_BILLING_* (2 vars)',
      href: 'https://console.cloud.google.com/billing/reports',
    });
  });
});

describe('every other tile, in each state', () => {
  it('a failed read keeps its link and says what failed', () => {
    const d = dashboardFixture({ overview: { ok: false, error: 'connection refused' } });
    for (const id of ['new-signups', 'total-users', 'active-trips', 'total-vehicles', 'deleted-accounts']) {
      const t = tileById(id, d);
      expect(t).toMatchObject({ value: '—', sub: 'read failed: connection refused', tone: 'danger' });
      expect(t.href).toMatch(/^\/admin\//);
    }
  });

  it('API failures: class split normally, the old Anthropic banner as a danger tone', () => {
    expect(tileById('api-failures')).toMatchObject({ value: '7', sub: '3 4xx · 2 5xx · 2 other', tone: 'warn', href: '/admin/errors?since=24h' });
    const d = dashboardFixture({ anthropicAlert: { ok: true, value: { failureCount: 4 } } });
    expect(tileById('api-failures', d)).toMatchObject({ sub: 'Anthropic failing: 4 in the last hour', tone: 'danger' });
  });

  it('Penny lockdown names its state — locked, tripped, near a limit, normal', () => {
    const at = (locked: boolean, worst: 'ok' | 'alert' | 'open') =>
      tileById('penny-lockdown', dashboardFixture({ penny: { ok: true, value: { locked, worst } } }));
    expect(at(true, 'ok')).toMatchObject({ value: 'LOCKED', tone: 'danger' });
    expect(at(false, 'open')).toMatchObject({ value: 'Breaker tripped', tone: 'danger' });
    expect(at(false, 'alert')).toMatchObject({ value: 'Near a limit', tone: 'warn' });
    expect(at(false, 'ok')).toMatchObject({ value: 'Normal', tone: 'good' });
  });

  it('paywall, classifier, promo, announcements, test users', () => {
    expect(tileById('paywall')).toMatchObject({ value: 'ON', href: '/admin/paywall' });
    expect(tileById('paywall', dashboardFixture({ paywallOn: { ok: true, value: false } }))).toMatchObject({ value: 'OFF', tone: 'warn' });
    expect(tileById('message-classifier')).toMatchObject({ value: 'HAIKU ONLY', href: '/admin/classifier' });
    expect(tileById('message-classifier', dashboardFixture({ jevMode: { ok: true, value: 'on' } })).value).toBe('JEV FIRST');
    expect(tileById('promo-codes')).toMatchObject({ value: '5 / 9', sub: 'redeemed of issued · 3 still open' });
    expect(tileById('announcements')).toMatchObject({ value: '1 active', href: '/admin/announcements' });
    expect(tileById('test-users')).toMatchObject({ value: 'Off in prod' });
    expect(tileById('test-users', dashboardFixture({ testUsers: { production: false, armed: true } })).value).toBe('Armed');
    expect(tileById('test-users', dashboardFixture({ testUsers: { production: false, armed: false } })).value).toBe('Disarmed');
  });

  it('recent chat and active users', () => {
    expect(tileById('recent-chat')).toMatchObject({ value: '17 trips', sub: '230 messages · last 5m ago', href: '/admin/chats' });
    expect(tileById('active-users')).toMatchObject({ value: '38', sub: '97 in 7d', href: '/admin/users?sort=active_desc' });
    expect(tileById('top-spenders', dashboardFixture({ topSpender: { ok: true, value: null } })).value).toBe('Nobody yet');
  });
});

describe('helpers', () => {
  it('settle returns the value, or the error with a log — never throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await settle('x', Promise.resolve(3))).toEqual({ ok: true, value: 3 });
    expect(await settle('x', Promise.reject(new Error('nope')))).toEqual({ ok: false, error: 'nope' });
    expect(log).toHaveBeenCalledWith('[admin] x failed:', 'nope');
  });

  it('shortens several missing variables to their shared prefix', () => {
    expect(missingVars(['ANTHROPIC_ADMIN_KEY'])).toBe('ANTHROPIC_ADMIN_KEY');
    expect(missingVars(['GOOGLE_BILLING_SA_KEY_JSON', 'GOOGLE_BILLING_EXPORT_TABLE'])).toBe('GOOGLE_BILLING_* (2 vars)');
    expect(missingVars(['A_KEY', 'B_KEY'])).toBe('A_KEY + B_KEY');
  });

  it('formats money and age', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.0123)).toBe('$0.0123');
    expect(fmtUsd(12.345)).toBe('$12.35');
    expect(fmtAgo(null, NOW)).toBe('never');
    expect(fmtAgo(new Date(NOW.getTime() - 3 * 3600_000), NOW)).toBe('3h ago');
  });
});
