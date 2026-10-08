/**
 * Tests for the resolve_place tool validator.
 *
 * resolve_place is the only sanctioned source of coordinates for a named
 * place, so its input is a query and an optional 2-letter region — never a
 * lat/lng Penny wrote herself. The validator is pure; no Google call happens
 * here (the lookup runs in the tool-use loop, not in this module).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, RESOLVE_PLACE } from './resolvePlace';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const parse = (input: unknown) => validator(ctx).safeParse(input);

describe('resolve_place validator', () => {
  it('accepts a bare query', () => {
    expect(parse({ query: 'Bergen' }).success).toBe(true);
  });

  it('accepts a query with a 2-letter region', () => {
    expect(parse({ query: 'Clean Kokos laundromat, Bergen', region: 'no' }).success).toBe(true);
  });

  it('accepts region null', () => {
    expect(parse({ query: 'Bergen', region: null }).success).toBe(true);
  });

  it('accepts a query at the 300-char cap and rejects one over it', () => {
    expect(parse({ query: 'a'.repeat(300) }).success).toBe(true);
    expect(parse({ query: 'a'.repeat(301) }).success).toBe(false);
  });

  it('rejects a missing, empty or non-string query', () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ query: '' }).success).toBe(false);
    expect(parse({ query: 42 }).success).toBe(false);
  });

  it('rejects a region that is not exactly two characters', () => {
    expect(parse({ query: 'Bergen', region: 'nor' }).success).toBe(false);
    expect(parse({ query: 'Bergen', region: 'n' }).success).toBe(false);
    expect(parse({ query: 'Bergen', region: 'Norway' }).success).toBe(false);
  });

  it('drops any coordinates Penny tries to supply', () => {
    const result = parse({ query: 'Bergen', lat: 60.39, lng: 5.32 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ query: 'Bergen' });
  });

  it('requires query in the schema Anthropic sees', () => {
    expect(tool.name).toBe(RESOLVE_PLACE);
    expect(tool.input_schema.required).toEqual(['query']);
  });
});
