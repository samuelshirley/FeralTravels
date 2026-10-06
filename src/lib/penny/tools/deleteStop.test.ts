/**
 * Tests for the delete_stop tool validator: one uuid, nothing else.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, DELETE_STOP } from './deleteStop';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const STOP_ID = '00000000-0000-0000-0000-000000000001';
const parse = (input: unknown) => validator(ctx).safeParse(input);

describe('delete_stop validator', () => {
  it('accepts a uuid stop_id', () => {
    expect(parse({ stop_id: STOP_ID }).success).toBe(true);
  });

  it('rejects a missing stop_id', () => {
    expect(parse({}).success).toBe(false);
  });

  it('rejects a non-uuid stop_id (sort order, name, number)', () => {
    expect(parse({ stop_id: '2' }).success).toBe(false);
    expect(parse({ stop_id: 'Circle K' }).success).toBe(false);
    expect(parse({ stop_id: 2 }).success).toBe(false);
    expect(parse({ stop_id: null }).success).toBe(false);
  });

  it('strips extra fields', () => {
    const result = parse({ stop_id: STOP_ID, leg_id: STOP_ID });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ stop_id: STOP_ID });
  });

  it('requires stop_id in the schema Anthropic sees', () => {
    expect(tool.name).toBe(DELETE_STOP);
    expect(tool.input_schema.required).toEqual(['stop_id']);
  });
});
