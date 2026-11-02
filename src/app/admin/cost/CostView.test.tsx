/**
 * The cost screen: provider-billed figures first, each provider's
 * unconfigured and error states said plainly, and the internal estimate last
 * and labelled as not a bill.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import CostView from './CostView';
import { ANTHROPIC_OK, GOOGLE_OK } from '@/test/adminDashboardFixture';

afterEach(cleanup);

const ESTIMATE = {
  ok: true as const,
  value: {
    rows: [
      { provider: 'anthropic', requests: 40, microcents: 120_000_000 },
      { provider: 'anthropic:gate', requests: 300, microcents: 900_000_000 },
    ],
    googleMonth: { grossUsd: 4.2, billableUsd: 0, perSku: [] },
  },
};

describe('CostView', () => {
  it('ok: Anthropic days newest first with today marked, cost lines, and the projection basis', () => {
    render(<CostView anthropic={{ status: 'ok', data: ANTHROPIC_OK }} google={{ status: 'ok', data: GOOGLE_OK }} estimate={ESTIMATE} />);
    const a = screen.getByTestId('cost-anthropic');
    expect(a).toHaveTextContent('2026-11-02 (today, so far)');
    expect(a).toHaveTextContent('$33.00/mo from the 7 full days ($7.70) × 30/7');
    expect(within(a).getByRole('link', { name: /Console/ })).toHaveAttribute('href', 'https://platform.claude.com/cost');
    expect(within(screen.getByTestId('cost-anthropic-lines')).getAllByRole('row')).toHaveLength(2);
  });

  it('ok: Google per service in the account currency, net of credits', () => {
    render(<CostView anthropic={{ status: 'ok', data: ANTHROPIC_OK }} google={{ status: 'ok', data: GOOGLE_OK }} estimate={ESTIMATE} />);
    const g = screen.getByTestId('cost-google');
    expect(g).toHaveTextContent('net €10.25');
    expect(screen.getByTestId('cost-google-services')).toHaveTextContent('Places API (New)€7.75');
  });

  it('unconfigured and failed providers say so by name', () => {
    render(
      <CostView
        anthropic={{ status: 'not_configured', missing: ['ANTHROPIC_ADMIN_KEY'] }}
        google={{ status: 'error', message: 'BigQuery query HTTP 403: Access Denied' }}
        estimate={ESTIMATE}
      />
    );
    expect(within(screen.getByTestId('cost-anthropic')).getByTestId('provider-not-configured')).toHaveTextContent(
      'Not configured — set ANTHROPIC_ADMIN_KEY to read Anthropic'
    );
    expect(within(screen.getByTestId('cost-google')).getByTestId('provider-error')).toHaveTextContent(
      'BigQuery query HTTP 403: Access Denied'
    );
    expect(screen.queryByTestId('cost-anthropic-lines')).not.toBeInTheDocument();
  });

  it('the internal estimate is labelled as not a bill and ranks provider tags by cost', () => {
    render(<CostView anthropic={{ status: 'ok', data: ANTHROPIC_OK }} google={{ status: 'ok', data: GOOGLE_OK }} estimate={ESTIMATE} />);
    const e = screen.getByTestId('cost-estimate');
    expect(within(e).getByRole('heading')).toHaveTextContent('Internal estimate — not a bill');
    const rows = within(screen.getByTestId('cost-estimate-rows')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('anthropic:gate');
    expect(rows[1]).toHaveTextContent('$9.00');
  });

  it('a failed estimate read says so', () => {
    render(
      <CostView anthropic={{ status: 'ok', data: ANTHROPIC_OK }} google={{ status: 'ok', data: GOOGLE_OK }} estimate={{ ok: false, error: 'timeout' }} />
    );
    expect(screen.getByTestId('cost-estimate')).toHaveTextContent('Estimate read failed: timeout');
  });
});
