/**
 * Every /admin screen, rendered as the server component it is, with the data
 * layer mocked: each one turns away a signed-out visitor and a non-admin, and
 * each one passes the right question to its read (the window, the sort, the
 * status class) and renders the answer.
 *
 * The controls these screens host (PaywallSwitch, JevSwitch, …) have their own
 * component tests; here they are stubs that record their props, because what
 * is new is that each now lives on its own page and receives the same data the
 * old single page gave it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  isAdmin: vi.fn(),
  requireWebAccess: vi.fn(async () => {}),
  production: { value: true },
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/server/auth', () => ({ auth: h.auth }));
vi.mock('@/server/auth/guards', () => ({ isAdmin: h.isAdmin }));
vi.mock('@/server/auth/webAccess', () => ({ requireWebAccess: h.requireWebAccess }));
vi.mock('@/components/AppNavbar', () => ({ default: () => null }));

const NOW = Date.now();
const repo = vi.hoisted(() => ({
  getAdminOverview: vi.fn(),
  getAnthropicHealthAlert: vi.fn(),
  getChatPulse: vi.fn(),
  getErrorCounts: vi.fn(),
  getTopUsersAllTime: vi.fn(),
  listNewSignups: vi.fn(),
  listAdminTrips: vi.fn(),
  getRecentChatActivity: vi.fn(),
  getProviderTotals: vi.fn(),
  listAllUsers: vi.fn(),
  listErrors: vi.fn(),
  listErrorProviders: vi.fn(),
}));
vi.mock('@/server/repos/admin', () => ({
  ...repo,
  USER_SORTS: ['joined_desc', 'joined_asc', 'name_asc', 'name_desc', 'spend_desc', 'active_desc', 'errors_desc'],
}));
const pay = vi.hoisted(() => ({
  paywallEnabled: vi.fn(),
  pennyLocked: vi.fn(),
  breakerSnapshot: vi.fn(),
  getPromoCodeStats: vi.fn(),
  getAccountVerdict: vi.fn(),
  gateMixSince: vi.fn(),
  topGatedAccounts: vi.fn(),
  formatBreakerValue: vi.fn(() => ''),
}));
vi.mock('@/server/payments', () => pay);
vi.mock('@/server/payments/testAccountGate', () => ({ testAccountsAvailable: () => true }));
vi.mock('@/server/productionGuard', () => ({ isProductionEnvironment: () => h.production.value }));
const spend = vi.hoisted(() => ({ readAnthropicSpend: vi.fn(), readGoogleSpend: vi.fn() }));
vi.mock('@/server/providerSpend', () => spend);
vi.mock('@/server/repos/announcements', () => ({ getAnnouncementStats: vi.fn(async () => ({ activeCount: 2, totalCount: 5 })) }));
const jev = vi.hoisted(() => ({
  globalJevMode: vi.fn(async () => 'compare'),
  getJevStats: vi.fn(async () => null),
  getJevCompareStats: vi.fn(async () => null),
  countJevOverrides: vi.fn(async () => null),
  jevConfigView: vi.fn(() => ({ configured: false })),
  JEV_MIN_MARGIN: 0.2,
}));
vi.mock('@/server/repos/jev', () => jev);
vi.mock('@/server/repos/usage', () => ({
  getGoogleBillableThisMonth: vi.fn(async () => ({ grossUsd: 1, billableUsd: 0, perSku: [] })),
}));
vi.mock('@/server/ipLimit', () => ({ recentIpLimitHits: vi.fn(async () => []) }));
vi.mock('@/server/repos/users', () => ({ lockedAccounts: vi.fn(async () => []) }));

function stub(name: string) {
  return {
    default: (props: Record<string, unknown>) => <div data-testid={`stub-${name}`} data-props={JSON.stringify(props)} />,
  };
}
vi.mock('./PaywallSwitch', () => stub('PaywallSwitch'));
vi.mock('./PennyLockdownBlock', () => stub('PennyLockdownBlock'));
vi.mock('./JevSwitch', () => stub('JevSwitch'));
vi.mock('./PromoCodeBlock', () => stub('PromoCodeBlock'));
vi.mock('./TestUserBlock', () => stub('TestUserBlock'));
vi.mock('./AdminTestErrorButton', () => stub('AdminTestErrorButton'));
vi.mock('./AdminErrorLog', () => stub('AdminErrorLog'));

import HomePage from './page';
import SignupsPage from './signups/page';
import TripsPage from './trips/page';
import ChatsPage from './chats/page';
import CostPage from './cost/page';
import PaywallPage from './paywall/page';
import PennyPage from './penny/page';
import ClassifierPage from './classifier/page';
import PromoPage from './promo/page';
import TestUsersPage from './test-users/page';
import UsersPage from './users/page';
import ErrorsPage from './errors/page';

const ADMIN = { user: { email: 'sam@feraltravels.com', name: 'Sam', image: null } };
const props = (searchParams: Record<string, string> = {}) => ({ searchParams });
const propsOf = (testId: string) => JSON.parse(screen.getByTestId(testId).getAttribute('data-props') ?? '{}');

beforeEach(() => {
  h.auth.mockResolvedValue(ADMIN);
  h.isAdmin.mockResolvedValue(true);
  h.production.value = true;
  repo.getAdminOverview.mockResolvedValue({
    totalUsers: 10, internalUsers: 1, newUsers24h: 3, newUsers7d: 8, activeUsers24h: 4, activeUsers7d: 6,
    totalTrips: 5, totalTemplates: 0, totalLegs: 20, totalVehicles: 7, totalDeletedUsers: 1,
  });
  repo.getAnthropicHealthAlert.mockResolvedValue(null);
  repo.getChatPulse.mockResolvedValue({ trips: 2, messages: 9, lastAt: new Date(NOW - 60_000) });
  repo.getErrorCounts.mockResolvedValue({ total: 3, c4xx: 1, c5xx: 1 });
  repo.getTopUsersAllTime.mockResolvedValue([{ name: 'Top', email: 't@example.org', microcents: '500000000' }]);
  repo.listNewSignups.mockResolvedValue({
    rows: [{ id: 'u1', email: 'new@example.org', name: 'New', createdAt: new Date(NOW - 3_600_000), lastActiveAt: null, tripCount: 0 }],
    hiddenInternal: 2,
    since: new Date(),
  });
  repo.listAdminTrips.mockResolvedValue([]);
  repo.getRecentChatActivity.mockResolvedValue([]);
  repo.getProviderTotals.mockResolvedValue([{ provider: 'anthropic', requests: '3', microcents: '1000000' }]);
  repo.listAllUsers.mockResolvedValue({ rows: [], total: 0, offset: 0, limit: 20 });
  repo.listErrors.mockResolvedValue({ rows: [], total: 0, offset: 0, limit: 20 });
  repo.listErrorProviders.mockResolvedValue([]);
  pay.paywallEnabled.mockResolvedValue(true);
  pay.pennyLocked.mockResolvedValue(false);
  pay.breakerSnapshot.mockResolvedValue({ worst: 'ok', statuses: [], facts: {} });
  pay.getPromoCodeStats.mockResolvedValue({ issued: 4, redeemed: 1, open: 2 });
  pay.getAccountVerdict.mockResolvedValue({ state: 'trial', entitled: true, enforced: true, trialEndsAt: null });
  pay.gateMixSince.mockResolvedValue([]);
  pay.topGatedAccounts.mockResolvedValue([]);
  spend.readAnthropicSpend.mockResolvedValue({ status: 'not_configured', missing: ['ANTHROPIC_ADMIN_KEY'] });
  spend.readGoogleSpend.mockResolvedValue({ status: 'not_configured', missing: ['GOOGLE_BILLING_SA_KEY_JSON', 'GOOGLE_BILLING_EXPORT_TABLE'] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type AnyPage = (p: { searchParams: Record<string, string> }) => Promise<React.ReactElement>;
const PAGES: Array<[string, AnyPage, string]> = [
  ['/admin', HomePage as AnyPage, 'Admin'],
  ['/admin/signups', SignupsPage as AnyPage, 'New signups'],
  ['/admin/trips', TripsPage as AnyPage, 'Trips'],
  ['/admin/chats', ChatsPage as AnyPage, 'Recent chat'],
  ['/admin/cost', CostPage as AnyPage, 'Cost'],
  ['/admin/paywall', PaywallPage as AnyPage, 'Paywall'],
  ['/admin/penny', PennyPage as AnyPage, 'Penny lockdown'],
  ['/admin/classifier', ClassifierPage as AnyPage, 'Message classifier'],
  ['/admin/promo', PromoPage as AnyPage, 'Promo codes'],
  ['/admin/test-users', TestUsersPage as AnyPage, 'Test users'],
];

describe.each(PAGES)('%s', (_route, Page, heading) => {
  it('runs the web gate, and sends a signed-out visitor to /login', async () => {
    h.auth.mockResolvedValue(null);
    await expect(Page(props())).rejects.toThrow('REDIRECT:/login');
    expect(h.requireWebAccess).toHaveBeenCalled();
  });

  it('sends a non-admin to /trips without reading anything', async () => {
    h.isAdmin.mockResolvedValue(false);
    await expect(Page(props())).rejects.toThrow('REDIRECT:/trips');
    for (const fn of [...Object.values(repo), spend.readAnthropicSpend, pay.paywallEnabled]) expect(fn).not.toHaveBeenCalled();
  });

  it('renders its heading for the admin', async () => {
    render(await Page(props()));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(heading);
  });
});

describe('/admin', () => {
  it('renders only the tile map, provider tiles saying they are not configured', async () => {
    render(await HomePage());
    expect(screen.getByTestId('admin-tile-new-signups')).toHaveTextContent('3');
    expect(screen.getByTestId('admin-tile-ai-spend-today')).toHaveTextContent('Not configured');
    expect(screen.getByTestId('admin-tile-google-billable')).toHaveTextContent('set GOOGLE_BILLING_* (2 vars)');
    expect(screen.getByTestId('admin-tile-message-classifier')).toHaveTextContent('COMPARE');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('one failed read marks its tiles and leaves the rest of the map standing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    repo.getAdminOverview.mockRejectedValue(new Error('db down'));
    render(await HomePage());
    expect(screen.getByTestId('admin-tile-new-signups')).toHaveTextContent('read failed: db down');
    expect(screen.getByTestId('admin-tile-promo-codes')).toHaveTextContent('1 / 4');
  });
});

describe('/admin/signups', () => {
  it('defaults to 7 days, gets each verdict from payments, and says how many internal signups it hid', async () => {
    render(await SignupsPage(props()));
    expect(repo.listNewSignups).toHaveBeenCalledWith(168, 200);
    expect(pay.getAccountVerdict).toHaveBeenCalledWith('u1');
    expect(screen.getByTestId('signup-row')).toHaveTextContent('new@example.org');
    expect(screen.getByText('2 internal account(s) in this window not shown.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'page');
  });

  it('honours the 24h window and ignores a made-up one', async () => {
    render(await SignupsPage(props({ window: '24h' })));
    expect(repo.listNewSignups).toHaveBeenCalledWith(24, 200);
    cleanup();
    render(await SignupsPage(props({ window: '9y' })));
    expect(repo.listNewSignups).toHaveBeenLastCalledWith(168, 200);
  });
});

describe('/admin/users and /admin/errors filters', () => {
  it('users: the spend filter reaches the repo and its pill is active', async () => {
    render(await UsersPage({ searchParams: { sort: 'spend_desc' } }));
    expect(repo.listAllUsers).toHaveBeenCalledWith(expect.objectContaining({ sort: 'spend_desc' }));
    const pills = within(screen.getByTestId('user-filters'));
    expect(pills.getByRole('link', { name: 'Top spend' })).toHaveAttribute('aria-current', 'page');
    expect(pills.getByRole('link', { name: 'Errors' })).toHaveAttribute('href', '/admin/users?sort=errors_desc');
  });

  it('users: an unknown sort falls back to newest', async () => {
    render(await UsersPage({ searchParams: { sort: 'drop table' } }));
    expect(repo.listAllUsers).toHaveBeenCalledWith(expect.objectContaining({ sort: 'joined_desc' }));
  });

  it('errors: the status class reaches the repo, the pill is active, and the test-error button is here now', async () => {
    render(await ErrorsPage({ searchParams: { status: '5xx', since: '24h' } }));
    expect(repo.listErrors).toHaveBeenCalledWith(expect.objectContaining({ statusClass: '5xx' }));
    const pills = within(screen.getByTestId('error-status-filter'));
    expect(pills.getByRole('link', { name: /5xx/ })).toHaveAttribute('aria-current', 'page');
    expect(pills.getByRole('link', { name: /4xx/ }).getAttribute('href')).toBe('/admin/errors?since=24h&status=4xx');
    expect(screen.getByTestId('stub-AdminTestErrorButton')).toBeInTheDocument();
  });

  it('errors: a made-up status is ignored', async () => {
    render(await ErrorsPage({ searchParams: { status: '418' } }));
    expect(repo.listErrors).toHaveBeenCalledWith(expect.objectContaining({ statusClass: null }));
  });
});

describe('control screens get what the old dashboard gave them', () => {
  it('paywall, promo and classifier', async () => {
    render(await PaywallPage());
    expect(propsOf('stub-PaywallSwitch')).toEqual({ on: true });
    cleanup();
    render(await PromoPage());
    expect(propsOf('stub-PromoCodeBlock')).toEqual({ paywallOn: true });
    cleanup();
    render(await ClassifierPage());
    expect(propsOf('stub-JevSwitch')).toMatchObject({ mode: 'compare', stats: null, minMargin: 0.2 });
  });

  it('penny reads the breakers live and hands over all five panels', async () => {
    render(await PennyPage());
    expect(propsOf('stub-PennyLockdownBlock')).toEqual({
      snapshot: { worst: 'ok', statuses: [], facts: {} },
      ipHits: [],
      gateMix: [],
      topGated: [],
      lockedOut: [],
    });
  });

  it('test users: refuses in production with directions, offers the generator elsewhere', async () => {
    render(await TestUsersPage());
    expect(screen.getByTestId('admin-test-users-production')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-TestUserBlock')).not.toBeInTheDocument();
    cleanup();
    h.production.value = false;
    render(await TestUsersPage());
    expect(propsOf('stub-TestUserBlock')).toEqual({ armed: true, paywallOn: true });
  });

  it('cost: estimate rows are numbers by the time they reach the view', async () => {
    render(await CostPage());
    expect(screen.getByTestId('cost-estimate-rows')).toHaveTextContent('$0.0100');
  });
});
