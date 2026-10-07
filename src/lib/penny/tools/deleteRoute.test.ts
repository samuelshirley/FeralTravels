/**
 * Tests for the delete_route tool validator: one uuid, nothing else.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, DELETE_ROUTE } from './deleteRoute';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const ROUTE_ID = '00000000-0000-0000-0000-000000000001';
const parse = (input: unknown) => validator(ctx).safeParse(input);

describe('delete_route validator', () => {
  it('accepts a uuid route_id', () => {
    expect(parse({ route_id: ROUTE_ID }).success).toBe(true);
  });

  it('rejects a missing route_id', () => {
    expect(parse({}).success).toBe(false);
  });

  it('rejects a non-uuid route_id', () => {
    expect(parse({ route_id: 'Camp B' }).success).toBe(false);
    expect(parse({ route_id: 1 }).success).toBe(false);
    expect(parse({ route_id: null }).success).toBe(false);
  });

  it('strips extra fields', () => {
    const result = parse({ route_id: ROUTE_ID, leg_id: ROUTE_ID });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ route_id: ROUTE_ID });
  });

  it('requires route_id in the schema Anthropic sees', () => {
    expect(tool.name).toBe(DELETE_ROUTE);
    expect(tool.input_schema.required).toEqual(['route_id']);
  });
});
