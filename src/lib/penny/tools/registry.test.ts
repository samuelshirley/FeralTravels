/**
 * Registry sweep for Penny's tools.
 *
 * Fails the moment a tool lands half-wired or untested:
 *  - every tool Anthropic sees (TOOLS) has a server-side validator (VALIDATORS)
 *    — an unvalidated tool input would reach the dispatcher raw, which is the
 *    "endpoints are locked down" invariant broken from the inside;
 *  - every tool is classified as exactly one of ACTION or LOOKUP, so the loop
 *    knows whether to dispatch it after the turn or run it inline;
 *  - every tool module in this directory is registered in index.ts, and every
 *    one has a `<toolName>.test.ts` of its own next to it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

vi.mock('server-only', () => ({}));

import * as registry from './index';
import { TOOLS, VALIDATORS, ACTION_TOOL_NAMES, LOOKUP_TOOL_NAMES } from './index';
import type { PennyContext } from '@/lib/penny/context';

const TOOLS_DIR = __dirname;
/** Files in this directory that are infrastructure, not tools. */
const NON_TOOL_FILES = new Set(['index.ts', 'shared.ts']);

interface ToolModule {
  tool: Anthropic.Tool;
  validator: (ctx: PennyContext) => unknown;
}

function isToolModule(value: unknown): value is ToolModule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const tool = v.tool as Record<string, unknown> | undefined;
  return typeof v.validator === 'function' && typeof tool?.name === 'string';
}

/** `addStop.ts` → `addStop`, for every tool source file on disk. */
const toolFilesOnDisk = readdirSync(TOOLS_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !NON_TOOL_FILES.has(f))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

/** The tool modules index.ts re-exports, keyed by their export name. */
const registeredModules = (Object.entries(registry) as [string, unknown][])
  .filter((entry): entry is [string, ToolModule] => isToolModule(entry[1]))
  .sort(([a], [b]) => a.localeCompare(b));

const toolNames = TOOLS.map((t) => t.name);

describe('Penny tool registry', () => {
  it('finds the tools (guards against the sweep silently checking nothing)', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    expect(toolFilesOnDisk.length).toBe(TOOLS.length);
  });

  it('has no duplicate tool names', () => {
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  it.each(toolNames)('%s has a VALIDATORS entry', (name) => {
    expect(VALIDATORS[name], `no validator registered for ${name}`).toBeTypeOf('function');
  });

  it('has no VALIDATORS entry for a tool Anthropic never sees', () => {
    expect(Object.keys(VALIDATORS).sort()).toEqual([...toolNames].sort());
  });

  it.each(toolNames)('%s is exactly one of ACTION or LOOKUP', (name) => {
    expect(ACTION_TOOL_NAMES.has(name) !== LOOKUP_TOOL_NAMES.has(name)).toBe(true);
  });

  it('classifies nothing that is not a tool', () => {
    for (const name of [...ACTION_TOOL_NAMES, ...LOOKUP_TOOL_NAMES]) {
      expect(toolNames, `${name} is classified but not in TOOLS`).toContain(name);
    }
  });

  it('registers every tool module in this directory', () => {
    expect(registeredModules.map(([key]) => key).sort()).toEqual(toolFilesOnDisk);
  });

  it.each(registeredModules)('%s: its tool is in TOOLS and its validator is the registered one', (_key, mod) => {
    expect(TOOLS).toContain(mod.tool);
    expect(VALIDATORS[mod.tool.name]).toBe(mod.validator);
  });

  it.each(toolFilesOnDisk)('%s has its own test file', (file) => {
    expect(existsSync(join(TOOLS_DIR, `${file}.test.ts`)), `missing ${file}.test.ts`).toBe(true);
  });

  it.each(toolNames)('%s validator factory returns a Zod schema for a minimal context', (name) => {
    const ctx = { legs: [], trip: { daily_drive_hours: null }, vehicle: null } as unknown as PennyContext;
    const schema = VALIDATORS[name](ctx);
    expect(typeof schema.safeParse).toBe('function');
  });
});
