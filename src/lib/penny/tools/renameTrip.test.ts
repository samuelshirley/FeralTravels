import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { lastDayFromLegDates } from '@/lib/tripCompletion';

import * as renameTrip from './renameTrip';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;

/**
 * The trip's end date is DERIVED from the legs, so `rename_trip` must not carry
 * a field for it.
 *
 * It did until 2026-09-09, which meant Penny had to remember to send one — and
 * Haiku did not: trip `ab824cde` has 13 legs and `end_date` NULL. An authored
 * end date is also stale the moment a day is added or removed, which is the
 * general reason this repo keeps derived facts out of tool schemas.
 */
describe('rename_trip does not author the end date', () => {
  it('rejects end_date on the validator', () => {
    const schema = renameTrip.validator(ctx);
    const parsed = schema.safeParse({ start_date: '2026-10-08', end_date: '2026-10-22' });
    // Zod strips unknown keys rather than failing, so assert on the OUTPUT:
    // whatever happens, an end date must not survive into the applied action.
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('end_date');
  });

  it('has no end_date in the tool schema Anthropic sees', () => {
    const props = (renameTrip.tool.input_schema as { properties?: Record<string, unknown> })
      .properties;
    expect(props).toBeDefined();
    expect(Object.keys(props ?? {})).not.toContain('end_date');
  });

  it('still accepts a name and a start date', () => {
    const schema = renameTrip.validator(ctx);
    expect(schema.safeParse({ name: 'Autumn loop' }).success).toBe(true);
    expect(schema.safeParse({ start_date: 'May 28, 2026' }).success).toBe(true);
  });

  it('still refuses an empty update', () => {
    expect(renameTrip.validator(ctx).safeParse({}).success).toBe(false);
  });

  it('never mentions end_date in the description Penny reads', () => {
    // She cannot send a field she is told to send but which does not exist.
    expect(renameTrip.tool.description ?? '').not.toMatch(/set end_date/i);
  });

  it('the dispatcher has no end_date branch left', () => {
    const route = readFileSync(
      join(__dirname, '..', '..', '..', 'app', 'api', 'trip', 'replan', 'route.ts'),
      'utf8'
    );
    expect(route).not.toMatch(/tripUpdate\.endDate\s*=/);
    expect(route).toContain('syncTripEndDateFromLegs');
  });
});

describe('the derivation that replaced it', () => {
  it('is the last leg date', () => {
    expect(lastDayFromLegDates(['2026-10-08', '2026-10-20', '2026-10-14'])).toBe('2026-10-20');
  });

  it('ignores missing and malformed dates rather than guessing', () => {
    expect(lastDayFromLegDates(['2026-10-08', null, undefined, 'someday'])).toBe('2026-10-08');
    expect(lastDayFromLegDates([null, undefined])).toBeNull();
    expect(lastDayFromLegDates([])).toBeNull();
  });
});
