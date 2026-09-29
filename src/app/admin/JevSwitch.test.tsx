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

import JevSwitch, {
  type JevCompareProps,
  type JevConfigProps,
  type JevModeProp,
  type JevStatsProps,
} from './JevSwitch';

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

/**
 * 200 compared. Haiku (rows) × Jev (columns):
 *   T1: 150 = 140 T1, 8 T2, 2 T3
 *   T2:  30 =   6 T1, 22 T2, 2 T3
 *   T3:  12 =   1 T1,  1 T2, 10 T3
 * plus 8 with no Jev answer. 172 agreed of 192 answered.
 */
const COMPARE: JevCompareProps = {
  days: 7,
  compared: 200,
  answered: 192,
  errors: 8,
  timeouts: 5,
  agreed: 172,
  matrix: {
    T1: { T1: 140, T2: 8, T3: 2 },
    T2: { T1: 6, T2: 22, T3: 2 },
    T3: { T1: 1, T2: 1, T3: 10 },
  },
  wouldSettle: 125,
  wouldPassHaikuRefused: 5,
  wouldPassHaikuT2: 4,
  wouldPassHaikuT3: 1,
  haikuT1: 150,
  haikuT1WouldSettle: 120,
  p50Ms: 88,
  p95Ms: 300,
};
const NO_COMPARE: JevCompareProps = {
  ...COMPARE,
  compared: 0,
  answered: 0,
  errors: 0,
  timeouts: 0,
  agreed: 0,
  matrix: { T1: { T1: 0, T2: 0, T3: 0 }, T2: { T1: 0, T2: 0, T3: 0 }, T3: { T1: 0, T2: 0, T3: 0 } },
  wouldSettle: 0,
  wouldPassHaikuRefused: 0,
  wouldPassHaikuT2: 0,
  wouldPassHaikuT3: 0,
  haikuT1: 0,
  haikuT1WouldSettle: 0,
  p50Ms: null,
  p95Ms: null,
};

function pendingFetch() {
  let release!: (res: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((r) => (release = r)));
  global.fetch = fetchMock as never;
  return { fetchMock, release: (res: Response) => act(async () => release(res)) };
}

const pill = (m: JevModeProp) => screen.getByTestId(`admin-jev-mode-${m}`);
const checked = () => screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true');
const base = {
  config: CONFIGURED,
  stats: STATS,
  compare: NO_COMPARE,
  overrides: { on: 0, compare: 0, off: 0 },
  minMargin: 0.2,
};

describe('JevSwitch', () => {
  beforeEach(() => refresh.mockReset());
  afterEach(cleanup);

  it.each([
    ['off', 'HAIKU ONLY'],
    ['compare', 'COMPARE'],
    ['on', 'JEV FIRST'],
  ] as const)('three pills; mode %s checks exactly %s', (mode, label) => {
    render(<JevSwitch mode={mode} {...base} />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['HAIKU ONLY', 'COMPARE', 'JEV FIRST']);
    expect(checked().map((r) => r.textContent)).toEqual([label]);
  });

  it.each([
    ['off', 'compare'],
    ['off', 'on'],
    ['compare', 'off'],
    ['compare', 'on'],
    ['on', 'off'],
    ['on', 'compare'],
  ] as const)('from %s, one tap on %s posts that mode, once', async (from, to) => {
    const { fetchMock, release } = pendingFetch();
    render(<JevSwitch mode={from} {...base} />);
    fireEvent.click(pill(to));
    fireEvent.click(pill(to));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/jev');
    expect(JSON.parse(init.body as string)).toEqual({ mode: to });
    expect((pill(to) as HTMLButtonElement).disabled).toBe(true);

    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('tapping the mode already on posts nothing', () => {
    const { fetchMock } = pendingFetch();
    render(<JevSwitch mode="compare" {...base} />);
    fireEvent.click(pill('compare'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a failure inline and leaves the true state checked', async () => {
    const { release } = pendingFetch();
    render(<JevSwitch mode="off" {...base} />);
    fireEvent.click(pill('on'));
    await release(new Response('<html/>', { status: 502 }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not change the Jev switch (502)');
    expect(checked().map((r) => r.textContent)).toEqual(['HAIKU ONLY']);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says where Jev is and the rule it settles by — never the key', () => {
    render(<JevSwitch mode="on" {...base} />);
    const text = screen.getByTestId('admin-jev-config').textContent ?? '';
    expect(text).toContain('gpu.example.com');
    expect(text).toContain('p ≥ 0.85');
    expect(text).toContain('≥ 0.2');
    expect(text).toContain('800 ms');
    expect(text).toContain('key set');
  });

  it('ON with no config says every message is still going to Haiku', () => {
    render(<JevSwitch mode="on" {...base} config={UNCONFIGURED} />);
    const text = screen.getByTestId('admin-jev-config').textContent ?? '';
    expect(text).toContain('JEV_BASE_URL is not set');
    expect(text).toContain('every message is still going to Haiku');
    cleanup();
    render(<JevSwitch mode="off" {...base} config={UNCONFIGURED} />);
    expect(screen.getByTestId('admin-jev-config').textContent).not.toContain('still going to Haiku');
    cleanup();
    render(<JevSwitch mode="compare" {...base} config={UNCONFIGURED} />);
    expect(screen.getByTestId('admin-jev-config').textContent).toContain('nothing is being compared');
  });

  it('reports the week: settled, passed on, failures, latency, dollars avoided', () => {
    render(<JevSwitch mode="on" {...base} />);
    const text = screen.getByTestId('admin-jev-stats').textContent ?? '';
    expect(text).toContain('Jev first, last 7 days');
    expect(text).toContain('settled 150 of 200 (75%)');
    expect(text).toContain('passed 50 to Haiku');
    expect(text).toContain('4 of them on an error (3 timeouts)');
    expect(text).toContain('p50 90 ms, p95 410 ms');
    expect(text).toContain('$0.1950 of Haiku avoided');
    expect(text).toContain('average of 312 classifier calls');
  });

  it('says which accounts ignore the switch, and nothing when none do', () => {
    render(<JevSwitch mode="on" {...base} overrides={{ on: 2, compare: 3, off: 1 }} />);
    expect(screen.getByTestId('admin-jev-overrides').textContent).toContain(
      '2 accounts forced to Jev first, 3 to compare and 1 to Haiku only',
    );
    cleanup();
    render(<JevSwitch mode="on" {...base} />);
    expect(screen.queryByTestId('admin-jev-overrides')).toBeNull();
  });

  it('a failed stats read is said, not rendered as zeros', () => {
    render(<JevSwitch mode="on" {...base} stats={null} />);
    expect(screen.getByText("Could not read Jev's results.")).toBeTruthy();
    expect(screen.queryByTestId('admin-jev-stats')).toBeNull();
  });
});

describe('the compare section', () => {
  afterEach(cleanup);

  it('leads with Jev-would-have-passed-Haiku-refused, and its rate out of would-settle', () => {
    render(<JevSwitch mode="compare" {...base} compare={COMPARE} />);
    const headline = screen.getByTestId('admin-jev-compare-headline');
    expect(headline.textContent).toContain('Jev would have passed, Haiku refused: 5 of 125');
    expect(headline.textContent).toContain('(4%)');
    expect(headline.textContent).toContain('4 T2, 1 T3');
    // The most prominent number on the card.
    expect(headline.querySelector('strong')?.textContent).toBe('5');
    expect(headline.querySelector('strong')?.getAttribute('style')).toContain('font-size: 22px');
  });

  it('says how many, the agreement rate, coverage and latency', () => {
    render(<JevSwitch mode="compare" {...base} compare={COMPARE} />);
    const text = screen.getByTestId('admin-jev-compare-summary').textContent ?? '';
    expect(text).toContain('200 compared');
    expect(text).toContain('Jev answered 192 (8 errors, 5 timeouts)');
    expect(text).toContain('agreed with Haiku on 172 (90%)');
    expect(text).toContain('skipped Haiku on 120 of 150 Haiku T1s (80%)');
    expect(text).toContain('p50 88 ms, p95 300 ms');
  });

  it('draws the 3×3: Haiku rows, Jev columns, the counts', () => {
    render(<JevSwitch mode="compare" {...base} compare={COMPARE} />);
    const table = screen.getByTestId('admin-jev-compare-matrix');
    const cells = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.children).map((c) => c.textContent),
    );
    expect(cells).toEqual([
      ['T1', '140', '8', '2'],
      ['T2', '6', '22', '2'],
      ['T3', '1', '1', '10'],
    ]);
    expect(screen.getByTestId('admin-jev-compare-T2-T1').textContent).toBe('6');
  });

  it('with no compare rows: says so in compare mode, silent otherwise', () => {
    render(<JevSwitch mode="compare" {...base} />);
    expect(screen.getByTestId('admin-jev-compare').textContent).toBe('No messages compared in the last 7 days.');
    cleanup();
    render(<JevSwitch mode="off" {...base} />);
    expect(screen.queryByTestId('admin-jev-compare')).toBeNull();
    cleanup();
    render(<JevSwitch mode="off" {...base} overrides={{ on: 0, compare: 1, off: 0 }} />);
    expect(screen.getByTestId('admin-jev-compare')).toBeTruthy();
  });

  it('rows from an earlier compare still show after switching away', () => {
    render(<JevSwitch mode="off" {...base} compare={COMPARE} />);
    expect(screen.getByTestId('admin-jev-compare-headline')).toBeTruthy();
  });

  it('a failed read is said, not rendered as zeros', () => {
    render(<JevSwitch mode="compare" {...base} compare={null} />);
    expect(screen.getByText('Could not read the comparison.')).toBeTruthy();
    expect(screen.queryByTestId('admin-jev-compare')).toBeNull();
  });
});

describe('/admin renders it', () => {
  it('with the live state, not a static pill', () => {
    const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/^import JevSwitch from '\.\/JevSwitch';$/m);
    expect(src).toMatch(/<JevSwitch\s+mode=\{jevMode\}/);
    expect(src).toMatch(/compare=\{jevCompare\}/);
    expect(src).toMatch(/getJevCompareStats\(7\)/);
  });
});
