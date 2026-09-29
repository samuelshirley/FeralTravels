/**
 * The Jev switch on /admin, and what it says beside itself.
 *
 * A component test for the same reason as `PaywallSwitch.test.tsx`: /admin is
 * behind a one-person allowlist and no fixture can sign in as an admin. The
 * route half is held by `adminEndpointCallerGuard` and `messageGateJev.test.ts`;
 * this file holds the control and the copy that explains it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import JevSwitch, { type JevConfigProps, type JevStatsProps } from './JevSwitch';

const CONFIGURED: JevConfigProps = {
  configured: true,
  host: 'gpu.example.com',
  model: 'typed-decisions',
  t1Min: 0.85,
  timeoutMs: 800,
  keySet: true,
  reason: null,
};
const UNCONFIGURED: JevConfigProps = {
  configured: false,
  host: null,
  model: null,
  t1Min: null,
  timeoutMs: null,
  keySet: false,
  reason: 'JEV_BASE_URL is not set',
};
const STATS: JevStatsProps = {
  days: 7,
  calls: 200,
  settled: 150,
  passedToHaiku: 50,
  errors: 4,
  timeouts: 3,
  p50Ms: 90,
  p95Ms: 410,
  classifierCallUsd: 0.0013,
  classifierCallSource: 'usage_events',
  classifierCallRows: 312,
  avoidedUsd: 0.195,
};

function pendingFetch() {
  let release!: (res: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((r) => (release = r)));
  global.fetch = fetchMock as never;
  return { fetchMock, release: (res: Response) => act(async () => release(res)) };
}

const pill = () => screen.getByTestId('admin-jev-switch');
const base = { config: CONFIGURED, stats: STATS, overrides: { on: 0, off: 0 }, minMargin: 0.2 };

describe('JevSwitch', () => {
  beforeEach(() => refresh.mockReset());
  afterEach(cleanup);

  it('names the state in the pill, and aria-checked agrees', () => {
    render(<JevSwitch on {...base} />);
    expect(pill().textContent).toBe('JEV FIRST');
    expect(pill().getAttribute('aria-checked')).toBe('true');
    cleanup();
    render(<JevSwitch on={false} {...base} />);
    expect(pill().textContent).toBe('HAIKU ONLY');
    expect(pill().getAttribute('aria-checked')).toBe('false');
  });

  it.each([true, false])('one tap from on=%s posts the other mode', async (on) => {
    const { fetchMock, release } = pendingFetch();
    render(<JevSwitch on={on} {...base} />);
    fireEvent.click(pill());
    fireEvent.click(pill());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/jev');
    expect(JSON.parse(init.body as string)).toEqual({ mode: on ? 'off' : 'on' });
    expect(pill().textContent).toBe('SWITCHING…');

    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('shows a failure inline and leaves the pill on the true state', async () => {
    const { release } = pendingFetch();
    render(<JevSwitch on={false} {...base} />);
    fireEvent.click(pill());
    await release(new Response('<html/>', { status: 502 }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not change the Jev switch (502)');
    expect(pill().textContent).toBe('HAIKU ONLY');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says where Jev is and the rule it settles by — never the key', () => {
    render(<JevSwitch on {...base} />);
    const text = screen.getByTestId('admin-jev-config').textContent ?? '';
    expect(text).toContain('gpu.example.com');
    expect(text).toContain('p ≥ 0.85');
    expect(text).toContain('≥ 0.2');
    expect(text).toContain('800 ms');
    expect(text).toContain('key set');
  });

  it('ON with no config says every message is still going to Haiku', () => {
    render(<JevSwitch on {...base} config={UNCONFIGURED} />);
    const text = screen.getByTestId('admin-jev-config').textContent ?? '';
    expect(text).toContain('JEV_BASE_URL is not set');
    expect(text).toContain('every message is still going to Haiku');
    cleanup();
    render(<JevSwitch on={false} {...base} config={UNCONFIGURED} />);
    expect(screen.getByTestId('admin-jev-config').textContent).not.toContain('still going to Haiku');
  });

  it('reports the week: settled, passed on, failures, latency, dollars avoided', () => {
    render(<JevSwitch on {...base} />);
    const text = screen.getByTestId('admin-jev-stats').textContent ?? '';
    expect(text).toContain('settled 150 of 200 (75%)');
    expect(text).toContain('passed 50 to Haiku');
    expect(text).toContain('4 of them on an error (3 timeouts)');
    expect(text).toContain('p50 90 ms, p95 410 ms');
    expect(text).toContain('$0.1950 of Haiku avoided');
    expect(text).toContain('average of 312 classifier calls');
  });

  it('says which accounts ignore the switch, and nothing when none do', () => {
    render(<JevSwitch on {...base} overrides={{ on: 2, off: 1 }} />);
    expect(screen.getByTestId('admin-jev-overrides').textContent).toContain('2 accounts forced to Jev and 1 to');
    cleanup();
    render(<JevSwitch on {...base} />);
    expect(screen.queryByTestId('admin-jev-overrides')).toBeNull();
  });

  it('a failed stats read is said, not rendered as zeros', () => {
    render(<JevSwitch on {...base} stats={null} />);
    expect(screen.getByText("Could not read Jev's results.")).toBeTruthy();
    expect(screen.queryByTestId('admin-jev-stats')).toBeNull();
  });
});

describe('/admin renders it', () => {
  it('with the live state, not a static pill', () => {
    const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/^import JevSwitch from '\.\/JevSwitch';$/m);
    expect(src).toMatch(/<JevSwitch\s+on=\{jevOn\}/);
  });
});
