/**
 * EntitlementNotice maps a server-resolved BlockReason to its copy and hands
 * it to the overlay. Four reasons, four different notices: two sell, two
 * apologise, and the apologetic ones never offer a purchase.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import EntitlementNotice from './EntitlementNotice';
import { APP_STORE_CTA_LABEL, SUPPORT_EMAIL, blockNoticeFor } from '@/lib/paywallCopy';
import type { BlockReason } from '@/types/entitlement';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SELLING: BlockReason[] = ['trial_over', 'subscription_over'];
const APOLOGETIC: BlockReason[] = ['usage_cap', 'revoked'];

describe('EntitlementNotice', () => {
  it.each([...SELLING, ...APOLOGETIC])('%s renders its own heading and body over the page', (reason) => {
    const notice = blockNoticeFor(reason);
    render(<EntitlementNotice blockReason={reason} />);
    const dialog = screen.getByRole('dialog', { name: notice.heading });
    expect(dialog).toHaveAttribute('data-block-reason', reason);
    expect(screen.getByText(notice.eyebrow)).toBeInTheDocument();
    for (const p of notice.body) expect(screen.getByText(p)).toBeInTheDocument();
  });

  it.each(SELLING)('%s is a sales moment: the App Store link, no support mailto', (reason) => {
    render(<EntitlementNotice blockReason={reason} />);
    expect(screen.getByRole('link', { name: APP_STORE_CTA_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: `Email ${SUPPORT_EMAIL}` })).not.toBeInTheDocument();
  });

  it.each(APOLOGETIC)('%s points at support and sells nothing', (reason) => {
    render(<EntitlementNotice blockReason={reason} />);
    expect(screen.getByRole('link', { name: `Email ${SUPPORT_EMAIL}` })).toHaveAttribute(
      'href',
      `mailto:${SUPPORT_EMAIL}`
    );
    expect(screen.queryByRole('link', { name: APP_STORE_CTA_LABEL })).not.toBeInTheDocument();
  });

  it('the usage cap and the revoke read differently (one is our cost, one is a suspension)', () => {
    const { unmount } = render(<EntitlementNotice blockReason="usage_cap" />);
    const capHeading = screen.getByRole('heading').textContent;
    unmount();
    render(<EntitlementNotice blockReason="revoked" />);
    expect(screen.getByRole('heading').textContent).not.toBe(capHeading);
  });

  it('renders without a request — the verdict came from the server render', () => {
    render(<EntitlementNotice blockReason="trial_over" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
