/**
 * The per-account paywall switch on /admin/users/[id].
 *
 * It once showed OFF on an account the deployment-wide paywall was walling —
 * it rendered the raw `users.paywall_enforced` column — and read as "this
 * account is not under the paywall". The switch shows whether the paywall
 * applies, so the global switch turns it on for everybody.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import PaywallEnforceControl from './PaywallEnforceControl';

const toggle = () => screen.getByTestId('admin-paywall-override-toggle');
const base = { userId: 'u-1', userLabel: 'a@example.com', comped: false };

describe('PaywallEnforceControl', () => {
  afterEach(cleanup);

  it('shows ON and is locked while the global paywall is on, override or not', () => {
    for (const enforced of [false, true]) {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as never;
      render(<PaywallEnforceControl {...base} enforced={enforced} globalOn />);
      expect(toggle().getAttribute('aria-checked')).toBe('true');
      expect((toggle() as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(toggle());
      expect(fetchMock).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('follows the override while the global paywall is off', () => {
    render(<PaywallEnforceControl {...base} enforced={false} globalOn={false} />);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect((toggle() as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    render(<PaywallEnforceControl {...base} enforced globalOn={false} />);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('says a comped account is exempt whenever the switch shows on', () => {
    render(<PaywallEnforceControl {...base} comped enforced={false} globalOn />);
    expect(screen.getByText('This account is comped')).toBeTruthy();
  });
});
