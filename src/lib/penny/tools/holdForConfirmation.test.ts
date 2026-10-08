/**
 * hold_for_confirmation — Penny's structured "this turn is a question and my
 * queued writes are the yes". The tool is the signal, never her prose, so its
 * schema must be tight and it must be a LOOKUP (run inline, never dispatched as
 * a write of its own).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, HOLD_FOR_CONFIRMATION } from './holdForConfirmation';
import { ACTION_TOOL_NAMES, LOOKUP_TOOL_NAMES } from './index';
import type { PennyContext } from '@/lib/penny/context';

const parse = (input: unknown) => validator({} as PennyContext).safeParse(input);

describe('hold_for_confirmation', () => {
  it('accepts the question she will end on', () => {
    expect(parse({ question: 'Both good?' }).success).toBe(true);
  });

  it('requires a real, bounded question', () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ question: '' }).success).toBe(false);
    expect(parse({ question: 'x'.repeat(301) }).success).toBe(false);
  });

  it('is a lookup run inline, not an action dispatched as a write', () => {
    expect(LOOKUP_TOOL_NAMES.has(HOLD_FOR_CONFIRMATION)).toBe(true);
    expect(ACTION_TOOL_NAMES.has(HOLD_FOR_CONFIRMATION)).toBe(false);
  });

  it('tells her to do the yes-work first and that the writes are held, not saved', () => {
    expect(tool.name).toBe(HOLD_FOR_CONFIRMATION);
    expect(tool.description).toMatch(/First do the work the YES answer needs/);
    expect(tool.description).toMatch(/HELD, not applied/);
    expect(tool.input_schema.required).toEqual(['question']);
  });
});
