import { test, expect } from '@playwright/test';
import { fixturePost, seedAccount, signedInAccount, type SignedInAccount } from './fixtures/api';
import { login } from './fixtures/auth';

/**
 * Feature requests over HTTP, as the iOS app asks (bearer token from the real
 * OTP sign-in): the list, one vote per account however often it is cast,
 * unvoting, voting closed on a Not doing request, and the order.
 *
 * The refusals (anonymous 401, malformed id 404, admin routes 401/403) are
 * rows in api-contracts.spec.ts. The admin WRITES cannot be made from here —
 * the allowlist is one real person — so requests are seeded through
 * /api/test/feature-request; the admin routes' behaviour is proven by their
 * route tests and the repo's PGlite round trips.
 *
 * Feature requests are GLOBAL: every spec and every iOS shard on this preview
 * sees every row. So nothing here asserts on the whole list — only on the ids
 * this spec seeded, and on their order relative to each other. Rows are left
 * in place: the preview is wiped on every push, and they are what the DB
 * column-coverage job counts.
 */

interface Row {
  id: string;
  title: string;
  body: string | null;
  status: string;
  reply: string | null;
  voteCount: number;
  votedByMe: boolean;
}

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let alice: SignedInAccount;
let bob: SignedInAccount;
let ids: { working: string; popular: string; quiet: string; closed: string };

async function seed(data: Record<string, unknown>): Promise<string> {
  return (await fixturePost<{ id: string }>('/api/test/feature-request', data)).id;
}

async function listFor(account: SignedInAccount): Promise<Row[]> {
  const res = await account.api.get('/api/feature-requests');
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { requests: Row[] }).requests;
}

function mine(list: Row[]): Row[] {
  const wanted = new Set(Object.values(ids));
  return list.filter((r) => wanted.has(r.id));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  [alice, bob] = await Promise.all([signedInAccount(), signedInAccount()]);
  ids = {
    working: await seed({
      title: `E2E ${RUN} working`,
      body: 'Show the price at the stations Finn picks.',
      status: 'in_progress',
      reply: 'Working on it.',
    }),
    popular: await seed({ title: `E2E ${RUN} popular`, body: 'Forecast for each night.' }),
    quiet: await seed({ title: `E2E ${RUN} quiet` }),
    closed: await seed({
      title: `E2E ${RUN} closed`,
      status: 'not_doing',
      reply: 'Booking stays with the campsite.',
    }),
  };
});

test.afterAll(async () => {
  for (const a of [alice, bob]) await a?.api.dispose();
});

test('the list carries title, description, status and reply, with no votes yet', async () => {
  const rows = mine(await listFor(alice));
  const working = rows.find((r) => r.id === ids.working);
  expect(working).toMatchObject({
    title: `E2E ${RUN} working`,
    body: 'Show the price at the stations Finn picks.',
    status: 'in_progress',
    reply: 'Working on it.',
    voteCount: 0,
    votedByMe: false,
  });
  expect(rows.find((r) => r.id === ids.quiet)).toMatchObject({ body: null, reply: null, status: 'open' });
});

test('a vote counts once, however many times it is sent', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await alice.api.put(`/api/feature-requests/${ids.popular}/vote`);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual({ voteCount: 1, votedByMe: true });
  }
});

test('votedByMe is per account, and the count is shared', async () => {
  const res = await bob.api.put(`/api/feature-requests/${ids.popular}/vote`);
  expect(await res.json()).toEqual({ voteCount: 2, votedByMe: true });

  const forAlice = (await listFor(alice)).find((r) => r.id === ids.popular);
  expect(forAlice).toMatchObject({ voteCount: 2, votedByMe: true });
  const quietForBob = (await listFor(bob)).find((r) => r.id === ids.quiet);
  expect(quietForBob).toMatchObject({ voteCount: 0, votedByMe: false });
});

test('one account can vote on every request that is open to voting', async () => {
  for (const id of [ids.working, ids.quiet]) {
    const res = await alice.api.put(`/api/feature-requests/${id}/vote`);
    expect(res.status(), await res.text()).toBe(200);
  }
  const rows = mine(await listFor(alice)).filter((r) => r.id !== ids.closed);
  expect(rows.every((r) => r.votedByMe)).toBe(true);
});

test('unvoting removes only your vote, and repeating it changes nothing', async () => {
  for (let i = 0; i < 2; i++) {
    const res = await alice.api.delete(`/api/feature-requests/${ids.quiet}/vote`);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual({ voteCount: 0, votedByMe: false });
  }
});

test('a Not doing request refuses a vote with 409 voting_closed', async () => {
  const res = await bob.api.put(`/api/feature-requests/${ids.closed}/vote`);
  expect(res.status(), await res.text()).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('voting_closed');
  const closed = (await listFor(bob)).find((r) => r.id === ids.closed);
  expect(closed).toMatchObject({ voteCount: 0, votedByMe: false, reply: 'Booking stays with the campsite.' });
});

test('an unknown request is 404 not_found', async () => {
  const res = await alice.api.put('/api/feature-requests/00000000-0000-4000-8000-00000000dead/vote');
  expect(res.status(), await res.text()).toBe(404);
  expect(((await res.json()) as { error: string }).error).toBe('not_found');
});

test('order: in progress first, then open by votes, then not doing', async () => {
  // working: 1 vote (in progress) · popular: 2 · quiet: 0 · closed: not doing
  const order = mine(await listFor(bob)).map((r) => r.id);
  expect(order).toEqual([ids.working, ids.popular, ids.quiet, ids.closed]);
});

/**
 * The WEB screen, driven in a browser the way a desktop user reaches it: the
 * account menu's "Feature requests" row (Sam, 2026-11-03: everything ships on
 * iOS AND desktop). iOS is mobile/maestro/feature-requests.yaml.
 */
test('web: the account menu opens Feature requests, and a vote counts and survives a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const account = await seedAccount();
  await login(page, account.email);

  await page.getByRole('button', { name: /account menu/i }).click();
  await page.getByTestId('account-menu-feature-requests').click();
  await expect(page).toHaveURL(/\/feature-requests$/);
  await expect(page.getByRole('heading', { name: 'Feature requests' })).toBeVisible();

  // In progress: the badge and the reply.
  const working = page.getByTestId(`feature-request-${ids.working}`);
  await expect(working.getByRole('img', { name: 'In progress' })).toBeVisible();
  await expect(working.getByText('Working on it.')).toBeVisible();

  // Open: vote (it is "popular", with alice's and bob's 2 already), then reload.
  const button = page.getByTestId(`feature-request-vote-${ids.popular}`);
  await expect(button).toHaveAttribute('aria-label', 'Vote. 2 votes');
  // The label flips optimistically, so wait for the server's answer before reloading (a reload raced the PUT in CI).
  const putDone = page.waitForResponse(
    (r) => r.url().endsWith(`/api/feature-requests/${ids.popular}/vote`) && r.request().method() === 'PUT',
  );
  await button.click();
  const put = await putDone;
  expect(put.status()).toBe(200);
  expect(await put.json()).toEqual({ voteCount: 3, votedByMe: true });
  await expect(button).toHaveAttribute('aria-label', 'Remove your vote. 3 votes');
  await page.reload();
  await expect(page.getByTestId(`feature-request-vote-${ids.popular}`)).toHaveAttribute(
    'aria-label',
    'Remove your vote. 3 votes',
  );

  // Not doing: the reason, and no vote button.
  await expect(page.getByText('NOT DOING')).toBeVisible();
  await expect(page.getByTestId(`feature-request-closed-${ids.closed}`)).toBeVisible();
  await expect(page.getByTestId(`feature-request-vote-${ids.closed}`)).toHaveCount(0);
  // Retries re-seed, so the reply text alone is not unique: scope it to this run's row.
  await expect(
    page.getByTestId(`feature-request-${ids.closed}`).getByText('Booking stays with the campsite.'),
  ).toBeVisible();
});
