/**
 * Tests for the report_position tool validator.
 *
 * The superRefine is the load-bearing part: next_leg_id must be a leg that is
 * actually on this trip (read from the live context), or omitted so the server
 * picks the nearest upcoming drive. An invented id would re-point nothing.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, REPORT_POSITION } from './reportPosition';
import type { PennyContext } from '@/lib/penny/context';

const LEG_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_LEG_ID = '00000000-0000-0000-0000-000000000002';
const FOREIGN_LEG_ID = '00000000-0000-0000-0000-00000000dead';

const ctx = {
  legs: [
    { id: LEG_ID, leg_type: 'drive' },
    { id: OTHER_LEG_ID, leg_type: 'rest' },
  ],
} as unknown as PennyContext;

const emptyCtx = { legs: [] } as unknown as PennyContext;

const ZURICH = { lat: 47.3769, lng: 8.5417 };
const parse = (input: unknown, c: PennyContext = ctx) => validator(c).safeParse(input);

describe('report_position validator — next_leg_id must be on this trip', () => {
  it('accepts a next_leg_id from context.legs', () => {
    expect(parse({ ...ZURICH, place_name: 'Zürich', next_leg_id: LEG_ID }).success).toBe(true);
  });

  it('rejects a next_leg_id that is not on this trip, on that path, pointing at context.legs', () => {
    const result = parse({ ...ZURICH, next_leg_id: FOREIGN_LEG_ID });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].path).toEqual(['next_leg_id']);
      expect(result.error.issues[0].message).toMatch(/context\.legs/);
    }
  });

  it('rejects any next_leg_id on a trip with no legs', () => {
    expect(parse({ ...ZURICH, next_leg_id: LEG_ID }, emptyCtx).success).toBe(false);
  });

  it('accepts omitting next_leg_id (server picks the nearest upcoming leg)', () => {
    expect(parse(ZURICH).success).toBe(true);
    expect(parse(ZURICH, emptyCtx).success).toBe(true);
  });

  it('accepts next_leg_id null', () => {
    expect(parse({ ...ZURICH, next_leg_id: null }).success).toBe(true);
  });

  it('rejects a non-uuid next_leg_id before the trip check runs', () => {
    expect(parse({ ...ZURICH, next_leg_id: 'leg-2' }).success).toBe(false);
  });
});

describe('report_position validator — shape', () => {
  it('accepts every field', () => {
    const result = parse({
      ...ZURICH,
      place_name: 'Zürich',
      next_leg_id: LEG_ID,
      resume_date: '2026-10-08',
      note: 'stopped short, too tired to push on',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing coordinates', () => {
    expect(parse({ lat: 47.37 }).success).toBe(false);
    expect(parse({ lng: 8.54 }).success).toBe(false);
    expect(parse({ place_name: 'Zürich' }).success).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    expect(parse({ lat: 91, lng: 8.54 }).success).toBe(false);
    expect(parse({ lat: 47.37, lng: -181 }).success).toBe(false);
  });

  it('rejects a resume_date that is not ISO YYYY-MM-DD', () => {
    for (const d of ['tomorrow', '08/10/2026', '2026-10-8', '2026-10-08T09:00:00Z']) {
      const result = parse({ ...ZURICH, resume_date: d });
      expect(result.success, d).toBe(false);
      if (!result.success) expect(result.error.issues[0].message).toMatch(/ISO YYYY-MM-DD/);
    }
  });

  it('rejects an empty or over-long place_name', () => {
    expect(parse({ ...ZURICH, place_name: '' }).success).toBe(false);
    expect(parse({ ...ZURICH, place_name: 'x'.repeat(201) }).success).toBe(false);
    expect(parse({ ...ZURICH, place_name: 'x'.repeat(200) }).success).toBe(true);
  });

  it('rejects a note over 500 chars', () => {
    expect(parse({ ...ZURICH, note: 'x'.repeat(501) }).success).toBe(false);
    expect(parse({ ...ZURICH, note: 'x'.repeat(500) }).success).toBe(true);
  });

  it('requires lat and lng in the schema Anthropic sees', () => {
    expect(tool.name).toBe(REPORT_POSITION);
    expect(tool.input_schema.required).toEqual(['lat', 'lng']);
  });
});
