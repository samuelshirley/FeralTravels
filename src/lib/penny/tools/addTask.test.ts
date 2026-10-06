/**
 * Tests for the add_task tool validator.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, ADD_TASK } from './addTask';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const LEG_ID = '00000000-0000-0000-0000-000000000001';
const parse = (input: unknown) => validator(ctx).safeParse(input);

describe('add_task validator', () => {
  it('accepts a trip-level task (leg_id omitted)', () => {
    expect(parse({ data: { title: 'Confirm ferry booking' } }).success).toBe(true);
  });

  it('accepts a trip-level task with leg_id null', () => {
    expect(parse({ leg_id: null, data: { title: 'Confirm ferry booking' } }).success).toBe(true);
  });

  it('accepts a leg-level task with every field set', () => {
    const result = parse({
      leg_id: LEG_ID,
      data: {
        title: "Pick tonight's stop",
        description: 'Camp A or Camp B',
        priority: 'high',
        reference_url: 'https://example.com/camps',
        reference_label: 'Camp list',
        reference_phone: '+47 123 45 678',
        due_at: '2026-10-08T18:00:00Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing data object', () => {
    expect(parse({ leg_id: LEG_ID }).success).toBe(false);
  });

  it('rejects a missing or empty title', () => {
    expect(parse({ data: {} }).success).toBe(false);
    const empty = parse({ data: { title: '' } });
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.error.issues[0].message).toBe('title is required');
  });

  it('rejects a non-uuid leg_id', () => {
    expect(parse({ leg_id: 'Day 2', data: { title: 'x' } }).success).toBe(false);
    expect(parse({ leg_id: 2, data: { title: 'x' } }).success).toBe(false);
  });

  it('rejects an unknown priority', () => {
    expect(parse({ data: { title: 'x', priority: 'urgent' } }).success).toBe(false);
  });

  it('rejects a reference_url that is not a URL', () => {
    expect(parse({ data: { title: 'x', reference_url: 'call the ferry office' } }).success).toBe(false);
  });

  it('rejects a non-string title', () => {
    expect(parse({ data: { title: 42 } }).success).toBe(false);
  });

  it('requires data and data.title in the schema Anthropic sees', () => {
    expect(tool.name).toBe(ADD_TASK);
    expect(tool.input_schema.required).toEqual(['data']);
    const data = (tool.input_schema.properties as { data: { required: string[] } }).data;
    expect(data.required).toEqual(['title']);
  });
});
