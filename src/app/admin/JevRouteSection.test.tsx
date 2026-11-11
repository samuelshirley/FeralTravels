/**
 * The route measurement on /admin. A component test for the same reason as
 * `JevSwitch.test.tsx`: /admin is behind a one-person allowlist and no
 * fixture can sign in as an admin. The numbers themselves come from
 * `summariseJevRoutes` (`messageGateJev`-style unit tests below) and the real
 * rows (`src/test/pg/jevRoute.test.ts`); this file holds what is SHOWN —
 * including that nothing is shown as a dollar figure before there is one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

import JevRouteSection, { type JevRouteStatsProps } from './JevRouteSection';

const EMPTY_INTENTS: JevRouteStatsProps['intents'] = [
  { route: 'add_pasted_place', routedConfident: 0, correctConfident: 0, truthCount: 0, costedRows: 0, avoidedUsd: 0 },
  { route: 'replace_fuel_stop', routedConfident: 0, correctConfident: 0, truthCount: 0, costedRows: 0, avoidedUsd: 0 },
  { route: 'off_topic', routedConfident: 0, correctConfident: 0, truthCount: 0, costedRows: 0, avoidedUsd: 0 },
  { route: 'needs_penny', routedConfident: 0, correctConfident: 0, truthCount: 0, costedRows: 0, avoidedUsd: 0 },
];

const NONE: JevRouteStatsProps = {
  days: 7,
  compared: 0,
  answered: 0,
  graded: 0,
  ungraded: 0,
  erroredTurns: 0,
  intents: EMPTY_INTENTS,
  gateOnly: { confidentRefusals: 0, agreed: 0, haikuSaidT1: 0, otherRefusalTier: 0, avoidedUsd: 0 },
  day: { graded: 0, matched: 0, byKind: {} },
  avgInputTokens: null,
};

const WEEK: JevRouteStatsProps = {
  days: 7,
  compared: 120,
  answered: 118,
  graded: 100,
  ungraded: 15,
  erroredTurns: 3,
  intents: [
    { route: 'add_pasted_place', routedConfident: 10, correctConfident: 9, truthCount: 12, costedRows: 9, avoidedUsd: 0.8123 },
    { route: 'replace_fuel_stop', routedConfident: 4, correctConfident: 2, truthCount: 5, costedRows: 1, avoidedUsd: 0.09 },
    { route: 'off_topic', routedConfident: 6, correctConfident: 6, truthCount: 8, costedRows: 6, avoidedUsd: 0.0081 },
    { route: 'needs_penny', routedConfident: 70, correctConfident: 66, truthCount: 75, costedRows: 0, avoidedUsd: 0 },
  ],
  gateOnly: { confidentRefusals: 7, agreed: 6, haikuSaidT1: 1, otherRefusalTier: 0, avoidedUsd: 0.0081 },
  day: { graded: 9, matched: 8, byKind: { day_number: 6, none: 3 } },
  avgInputTokens: 74,
};

describe('JevRouteSection', () => {
  afterEach(cleanup);

  it('is not shown outside compare mode', () => {
    const { container } = render(<JevRouteSection routes={WEEK} show={false} />);
    expect(container.textContent).toBe('');
  });

  it('a failed read says so, rather than showing zeros', () => {
    render(<JevRouteSection routes={null} show />);
    expect(screen.getByText('Could not read the route measurement.')).toBeTruthy();
  });

  it('no compared messages: says so, and shows no table and no dollars', () => {
    render(<JevRouteSection routes={NONE} show />);
    expect(screen.getByTestId('admin-jev-routes').textContent).toBe(
      'Route question: no messages compared in the last 7 days.',
    );
    expect(screen.queryByTestId('admin-jev-routes-table')).toBeNull();
    expect(document.body.textContent).not.toContain('$');
  });

  it('compared but nothing graded yet: no precision, no dollar figure', () => {
    render(<JevRouteSection routes={{ ...NONE, compared: 4, answered: 4, ungraded: 4 }} show />);
    expect(screen.getByTestId('admin-jev-routes-ungraded').textContent).toContain('Nothing graded yet');
    expect(screen.queryByTestId('admin-jev-routes-table')).toBeNull();
    expect(screen.getByTestId('admin-jev-routes-gate').textContent).toContain('decided those: —');
    expect(document.body.textContent).not.toContain('$');
  });

  it('a graded week: precision, coverage and the measured dollars, per route', () => {
    render(<JevRouteSection routes={WEEK} show />);
    const row = (r: string) => screen.getByTestId(`admin-jev-route-${r}`).textContent;
    // 9 right of 10 sure = 90% precision; 9 of 12 needed = 75% coverage; $0.8123.
    expect(row('add_pasted_place')).toBe('Add a pasted Maps place10990%1275%$0.8123');
    // A correct route whose turn has no cost row is said, not silently priced at zero.
    expect(screen.getByTestId('admin-jev-route-replace_fuel_stop-avoided').textContent).toBe(
      '$0.0900 (1 without a cost row)',
    );
    expect(screen.getByTestId('admin-jev-route-needs_penny-avoided').textContent).toBe('n/a');
    expect(screen.getByTestId('admin-jev-routes-summary').textContent).toContain('100 graded');
    expect(screen.getByTestId('admin-jev-routes-summary').textContent).toContain('74 input tokens a call');
    expect(screen.getByTestId('admin-jev-routes-gate').textContent).toContain(
      'Jev confidently refused 7 — Haiku agreed on 6 (86%), let 1 through as T1',
    );
    expect(screen.getByTestId('admin-jev-routes-day').textContent).toContain(
      "matched Penny's day on 8 of 9 (89%); forms: day_number 6, none 3",
    );
  });

  it('a route Jev never got right shows a dash, not $0', () => {
    const intents = WEEK.intents.map((i) =>
      i.route === 'add_pasted_place' ? { ...i, correctConfident: 0, costedRows: 0, avoidedUsd: 0 } : i,
    );
    render(<JevRouteSection routes={{ ...WEEK, intents }} show />);
    expect(screen.getByTestId('admin-jev-route-add_pasted_place-avoided').textContent).toBe('—');
  });
});
