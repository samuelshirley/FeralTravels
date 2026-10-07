/**
 * useTripPaywallLock: the workspace's scrim notice + the ONE purchase sheet.
 * A selling block's button opens the sheet; an apologetic block links to
 * support and never opens a sheet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useTripPaywallLock } from './TripPaywallLock';
import { SUPPORT_EMAIL, blockNoticeFor } from '@/lib/paywallCopy';
import type { BlockReason } from '@/types/entitlement';

function Harness({ blockReason }: { blockReason: BlockReason | null }) {
  const { locked, notice, sheet } = useTripPaywallLock(blockReason);
  return (
    <div>
      <output data-testid="locked">{String(locked)}</output>
      <div data-testid="pane">{notice}</div>
      {sheet}
    </div>
  );
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useTripPaywallLock', () => {
  it('an entitled account (null) is not locked and draws nothing', () => {
    render(<Harness blockReason={null} />);
    expect(screen.getByTestId('locked')).toHaveTextContent('false');
    expect(screen.getByTestId('pane')).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each<BlockReason>(['trial_over', 'subscription_over'])(
    '%s: locked, with the kicker, heading, one line about the panes, and the plan button',
    (reason) => {
      const notice = blockNoticeFor(reason);
      render(<Harness blockReason={reason} />);
      expect(screen.getByTestId('locked')).toHaveTextContent('true');
      const section = screen.getByRole('region', { name: notice.heading });
      expect(section).toHaveAttribute('data-block-reason', reason);
      expect(section).toHaveTextContent(notice.eyebrow);
      expect(section).toHaveTextContent(/Your trip is still here to look at/);
      expect(screen.getByRole('button', { name: notice.action.label })).toBeInTheDocument();
      // Not a second copy of Penny's message: the body paragraphs are not here.
      for (const p of notice.body) expect(section).not.toHaveTextContent(p);
    }
  );

  it('the plan button opens the purchase sheet once, and closing it removes it', () => {
    render(<Harness blockReason="trial_over" />);
    expect(screen.queryByRole('dialog', { name: 'Get the app' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: blockNoticeFor('trial_over').action.label }));
    expect(screen.getAllByRole('dialog', { name: 'Get the app' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Get the app' })).not.toBeInTheDocument();
    // Opening and closing the sheet costs no request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<BlockReason>(['usage_cap', 'revoked'])(
    '%s: locked, with a support mailto and no purchase button',
    (reason) => {
      render(<Harness blockReason={reason} />);
      expect(screen.getByTestId('locked')).toHaveTextContent('true');
      const link = screen.getByRole('link', { name: `Email ${SUPPORT_EMAIL}` });
      expect(link).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`);
      expect(screen.queryByTestId('trip-pane-lock-cta')).not.toBeInTheDocument();
    }
  );

  it('the notice is a note, not a modal dialog — the chat beside it stays reachable', () => {
    render(<Harness blockReason="trial_over" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('trip-pane-lock')).not.toHaveAttribute('aria-modal');
  });
});
