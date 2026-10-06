/**
 * Tests for the submit_idea tool validator.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, SUBMIT_IDEA } from './submitIdea';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const parse = (input: unknown) => validator(ctx).safeParse(input);

describe('submit_idea validator', () => {
  it('accepts an idea alone', () => {
    expect(parse({ idea: 'wants live fuel prices to pick the cheapest station' }).success).toBe(true);
  });

  it('accepts an idea with an area tag (or null)', () => {
    expect(parse({ idea: 'show live traffic', area: 'maps' }).success).toBe(true);
    expect(parse({ idea: 'show live traffic', area: null }).success).toBe(true);
  });

  it('rejects a missing or empty idea', () => {
    expect(parse({}).success).toBe(false);
    const empty = parse({ idea: '' });
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.error.issues[0].message).toBe('idea is required');
  });

  it('caps the idea at 1000 chars', () => {
    expect(parse({ idea: 'x'.repeat(1000) }).success).toBe(true);
    expect(parse({ idea: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('caps the area tag at 60 chars', () => {
    expect(parse({ idea: 'x', area: 'a'.repeat(60) }).success).toBe(true);
    expect(parse({ idea: 'x', area: 'a'.repeat(61) }).success).toBe(false);
  });

  it('rejects a non-string idea', () => {
    expect(parse({ idea: ['fuel prices'] }).success).toBe(false);
  });

  it('requires idea in the schema Anthropic sees', () => {
    expect(tool.name).toBe(SUBMIT_IDEA);
    expect(tool.input_schema.required).toEqual(['idea']);
  });
});
