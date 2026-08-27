/**
 * Guardrail: a seeded trip is never in the past.
 *
 * Two halves, because the failure has two shapes.
 *
 * 1. The RULE — `seededTripStartISO` is asserted against a described moment
 *    rather than a live database, so it runs in the unit suite and catches a
 *    broken offset in seconds instead of in a Playwright run against a
 *    preview.
 * 2. The HABIT — a source scan over every module that seeds fixture data,
 *    failing on a hardcoded ISO calendar date. The rule above cannot help if
 *    the next fixture simply writes `'2026-06-01'` again, which is exactly
 *    what the canonical two-leg fixture used to do. A date literal is correct
 *    the day it is typed and wrong forever after; nothing else in CI notices
 *    the day it turns.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SEEDED_TRIP_START_OFFSET_DAYS,
  seededLegDateISO,
  seededTripStartISO,
} from './seedDates';
import { daysBetweenISO, todayISOInZone } from '@/lib/dates';

describe('the seeded-trip start rule', () => {
  it('is a future offset, not a calendar date', () => {
    expect(SEEDED_TRIP_START_OFFSET_DAYS).toBeGreaterThan(0);
  });

  /**
   * Moments chosen for the ways date math breaks: a year boundary, a leap
   * day, a month with 31 days rolling into one with 30, both DST switches in
   * the northern hemisphere, and a plain midday.
   */
  const MOMENTS = [
    '2026-12-31T23:59:59.000Z',
    '2028-02-29T00:00:00.000Z',
    '2026-01-31T12:00:00.000Z',
    '2026-03-29T01:30:00.000Z',
    '2026-10-25T01:30:00.000Z',
    '2026-06-15T12:00:00.000Z',
  ];

  const ZONES = [null, 'UTC', 'Europe/Oslo', 'America/Los_Angeles', 'Pacific/Kiritimati'];

  for (const moment of MOMENTS) {
    for (const zone of ZONES) {
      it(`starts ${SEEDED_TRIP_START_OFFSET_DAYS} days out at ${moment} in ${zone ?? 'runtime-local'}`, () => {
        const now = new Date(moment);
        const today = todayISOInZone(zone, now);
        const start = seededTripStartISO(now, zone);

        expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(daysBetweenISO(today, start)).toBe(SEEDED_TRIP_START_OFFSET_DAYS);
      });
    }
  }

  it('never lands on or before today, whatever zone the driver is in', () => {
    for (const moment of MOMENTS) {
      const now = new Date(moment);
      for (const zone of ZONES) {
        // Compared against every zone's "today", not just the seeding zone:
        // the server seeds in UTC and the browser folds days in the driver's
        // zone, so the cushion has to survive the widest disagreement between
        // the two (Kiritimati to Los Angeles is 24 hours of it).
        const start = seededTripStartISO(now, null);
        expect(daysBetweenISO(todayISOInZone(zone, now), start)!).toBeGreaterThan(0);
      }
    }
  });

  it('gives each leg its own day, all of them still ahead', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const today = todayISOInZone(null, now);
    for (let i = 0; i < 10; i++) {
      expect(daysBetweenISO(today, seededLegDateISO(i, now))).toBe(
        SEEDED_TRIP_START_OFFSET_DAYS + i,
      );
    }
  });
});

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Every module that creates fixture or seed trip data. A new one belongs on
 * this list — the point is the habit, not these four paths.
 */
const FIXTURE_SOURCES = [
  'src/server/repos/testSupport.ts',
  'src/app/api/test',
  'e2e',
  'scripts/seed-demo-trip.ts',
  'scripts/seed-first-announcement.ts',
];

/**
 * Both shapes a trip date gets written in. The second exists because the drift
 * that prompted this guard was not ISO: `onboarding-flow.spec.ts` typed
 * `'June 3 2026'` into the wizard's date step, which an ISO-only pattern reads
 * straight past.
 */
const DATE_LITERALS = [
  /\b(19|20)\d{2}-\d{2}-\d{2}\b/,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s+(19|20)\d{2}\b/i,
  /\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(19|20)\d{2}\b/i,
];

function collect(target: string): string[] {
  const full = path.join(REPO_ROOT, target);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [full];
  return fs
    .readdirSync(full, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? collect(path.join(target, entry.name))
        : entry.name.endsWith('.ts')
          ? [path.join(full, entry.name)]
          : [],
    );
}

/**
 * A date in prose is a fact about when something was decided and is worth
 * keeping; a date in code is the bug. Lines opening with `//`, `*` or `/*` are
 * comments in this repo's style, so they are skipped. `.test.ts` files are
 * skipped too — a spec asserting on a fixed moment (this file does) is
 * describing a scenario, not seeding one.
 */
function offendingLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return false;
      }
      return DATE_LITERALS.some((re) => re.test(line));
    })
    .map(({ line, n }) => `  ${n}: ${line.trim()}`);
}

describe('fixture sources carry no hardcoded calendar dates', () => {
  const files = FIXTURE_SOURCES.flatMap(collect).filter((f) => !f.endsWith('.test.ts'));

  it('finds the fixture modules to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    it(`${rel} has none`, () => {
      const offenders = offendingLines(file);
      expect(
        offenders,
        `${rel} hardcodes a calendar date. A seeded trip must derive its dates from ` +
          `SEEDED_TRIP_START_OFFSET_DAYS (src/app/api/test/seedDates.ts) — a literal date is ` +
          `future-dated the day it is written and a past trip a few months later.\n` +
          offenders.join('\n'),
      ).toEqual([]);
    });
  }
});
