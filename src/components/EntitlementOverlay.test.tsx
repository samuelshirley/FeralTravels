/**
 * The hard block laid over /trips. A selling notice carries the purchase
 * options inline; an apologetic one carries the support mailto and nothing to
 * buy. Account settings (sign-out, deletion) is reachable from both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import EntitlementOverlay from './EntitlementOverlay';
import { APP_STORE_CTA_LABEL, blockNoticeFor, type BlockNotice } from '@/lib/paywallCopy';

const SELL: BlockNotice = {
  eyebrow: 'TRIAL ENDED',
  heading: 'Your free trial is over',
  body: ['Pick a plan in the app.', 'Your trips are all still here.'],
  action: { label: 'Pick a plan', href: 'https://apps.apple.com/x' },
  tone: 'sell',
};

const APOLOGISE: BlockNotice = {
  eyebrow: 'PLANNING PAUSED',
  heading: 'We have paused planning on this account',
  body: ['This is a ceiling on our own costs.'],
  action: { label: 'Email support@feraltravels.com', href: 'mailto:support@feraltravels.com' },
  tone: 'apologise',
};

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EntitlementOverlay', () => {
  it('is a modal dialog named by the heading, tagged with the block reason', () => {
    render(<EntitlementOverlay blockReason="trial_over" notice={SELL} />);
    const dialog = screen.getByRole('dialog', { name: SELL.heading });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('data-block-reason', 'trial_over');
    expect(within(dialog).getByText('TRIAL ENDED')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: SELL.heading })).toBeInTheDocument();
    for (const p of SELL.body) expect(within(dialog).getByText(p)).toBeInTheDocument();
  });

  it('a selling block shows the App Store link and the promo field, and no mailto', () => {
    render(<EntitlementOverlay blockReason="trial_over" notice={SELL} />);
    expect(screen.getByRole('link', { name: APP_STORE_CTA_LABEL })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Promo code' })).toBeInTheDocument();
    expect(screen.queryByTestId('entitlement-overlay-cta')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an apologetic block shows the support mailto and nothing to buy', () => {
    render(<EntitlementOverlay blockReason="usage_cap" notice={APOLOGISE} />);
    const cta = screen.getByRole('link', { name: APOLOGISE.action.label });
    expect(cta).toHaveAttribute('href', 'mailto:support@feraltravels.com');
    expect(screen.queryByRole('link', { name: APP_STORE_CTA_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Promo code' })).not.toBeInTheDocument();
  });

  it('Account settings is reachable from every block (sign-out and deletion live there)', () => {
    const { rerender } = render(<EntitlementOverlay blockReason="trial_over" notice={SELL} />);
    expect(screen.getByRole('link', { name: 'Account settings' })).toHaveAttribute('href', '/settings');
    rerender(<EntitlementOverlay blockReason="revoked" notice={APOLOGISE} />);
    expect(screen.getByRole('link', { name: 'Account settings' })).toHaveAttribute('href', '/settings');
  });

  it('offers no link to Penny (her composer is disabled while blocked)', () => {
    // The real notice whose body names Penny — the body may, a link may not.
    const notice = blockNoticeFor('subscription_over');
    render(<EntitlementOverlay blockReason="subscription_over" notice={notice} />);
    expect(screen.getByText(/Penny are paused/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /penny/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /penny/i })).not.toBeInTheDocument();
  });
});
