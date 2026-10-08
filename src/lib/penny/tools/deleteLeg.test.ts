/**
 * Tests for the delete_leg tool validator: one uuid, nothing else.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, DELETE_LEG } from './deleteLeg';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const LEG_ID = '00000000-0000-0000-0000-000000000001';
const parse = (input: unknown) => validator(ctx).safeParse(input);

describe('delete_leg validator', () => {
  it('accepts a uuid leg_id', () => {
    expect(parse({ leg_id: LEG_ID }).success).toBe(true);
  });

  it('rejects a missing leg_id', () => {
    expect(parse({}).success).toBe(false);
  });

  it('rejects a non-uuid leg_id (an ordinal or day number is not an id)', () => {
    expect(parse({ leg_id: '3' }).success).toBe(false);
    expect(parse({ leg_id: 'Day 3' }).success).toBe(false);
    expect(parse({ leg_id: 3 }).success).toBe(false);
    expect(parse({ leg_id: null }).success).toBe(false);
  });

  it('strips extra fields', () => {
    const result = parse({ leg_id: LEG_ID, cascade: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ leg_id: LEG_ID });
  });

  it('requires leg_id in the schema Anthropic sees', () => {
    expect(tool.name).toBe(DELETE_LEG);
    expect(tool.input_schema.required).toEqual(['leg_id']);
  });
});
