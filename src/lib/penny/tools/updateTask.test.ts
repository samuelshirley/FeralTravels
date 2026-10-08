/**
 * Tests for the update_task tool validator.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, UPDATE_TASK } from './updateTask';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const TASK_ID = '00000000-0000-0000-0000-000000000001';
const parse = (input: unknown) => validator(ctx).safeParse(input);
const withData = (data: Record<string, unknown>) => parse({ task_id: TASK_ID, data });

describe('update_task validator', () => {
  it('accepts marking a task answered with its answer', () => {
    const result = withData({
      status: 'answered',
      answer: 'Ferry leaves 14:00',
      answer_source_url: 'https://example.com/timetable',
      answer_image_url: 'https://example.com/timetable.png',
    });
    expect(result.success).toBe(true);
  });

  it('accepts dismissing a task', () => {
    expect(withData({ status: 'dismissed' }).success).toBe(true);
  });

  it('accepts an empty data object', () => {
    expect(withData({}).success).toBe(true);
  });

  it('rejects a missing or non-uuid task_id', () => {
    expect(parse({ data: { status: 'dismissed' } }).success).toBe(false);
    expect(parse({ task_id: 'task-1', data: { status: 'dismissed' } }).success).toBe(false);
  });

  it('rejects a missing data object', () => {
    expect(parse({ task_id: TASK_ID }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(withData({ status: 'done' }).success).toBe(false);
    expect(withData({ status: 'completed' }).success).toBe(false);
  });

  it('rejects non-URL answer links', () => {
    expect(withData({ answer_source_url: 'the website' }).success).toBe(false);
    expect(withData({ answer_image_url: 'photo.png' }).success).toBe(false);
  });

  it('strips fields Penny may not edit on a task (title, priority)', () => {
    const result = withData({ status: 'answered', title: 'Renamed', priority: 'high' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data).not.toHaveProperty('title');
      expect(result.data.data).not.toHaveProperty('priority');
    }
  });

  it('requires task_id and data in the schema Anthropic sees', () => {
    expect(tool.name).toBe(UPDATE_TASK);
    expect(tool.input_schema.required).toEqual(['task_id', 'data']);
  });
});
