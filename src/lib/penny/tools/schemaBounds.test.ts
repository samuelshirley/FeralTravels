/**
 * The bounds Anthropic sees are the bounds the server enforces.
 *
 * A tool's JSON schema is what Penny writes against; its Zod validator is what
 * the server accepts. When they disagree she can send a value her own schema
 * allowed and have it refused — `minimum: 0` on fields the server holds to
 * `.positive()` did exactly that on add_route, update_route, add_leg,
 * update_leg and update_stop until 2026-10-07.
 *
 * Every property with one of these names, in every registered tool, must carry
 * the shared JSON bounds from ./shared.ts — the same file as the Zod schemas.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { TOOLS } from './index';
import { distanceKmJson, driveTimeMinutesJson, fuelAmountLJson } from './shared';
import { validator as addRouteValidator } from './addRoute';
import { validator as updateStopValidator } from './updateStop';
import type { PennyContext } from '@/lib/penny/context';

const BOUNDED: Record<string, Record<string, unknown>> = {
  distance_km: distanceKmJson,
  drive_time_minutes: driveTimeMinutesJson,
  fuel_amount_l: fuelAmountLJson,
};

type Schema = { properties?: Record<string, Schema>; items?: Schema } & Record<string, unknown>;

/** Every [toolName, propertyName, schema] in a tool's input schema, nested. */
function walk(tool: string, schema: Schema, out: [string, string, Schema][] = []): [string, string, Schema][] {
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    out.push([tool, name, prop]);
    walk(tool, prop, out);
  }
  if (schema.items) walk(tool, schema.items, out);
  return out;
}

const props = TOOLS.flatMap((t) => walk(t.name, t.input_schema as Schema));
const bounded = props.filter(([, name]) => name in BOUNDED);

describe('tool schema bounds', () => {
  it('finds the bounded fields it is checking', () => {
    const tools = new Set(bounded.map(([tool]) => tool));
    for (const t of ['add_route', 'update_route', 'add_leg', 'update_leg', 'update_stop']) {
      expect(tools.has(t), t).toBe(true);
    }
  });

  it.each(bounded.map(([tool, name, schema]) => [`${tool}.${name}`, name, schema] as const))(
    '%s states the bounds the server enforces',
    (_label, name, schema) => {
      expect(schema).toMatchObject(BOUNDED[name]);
      expect(schema).not.toHaveProperty('minimum', 0);
    },
  );

  it('the server refuses exactly what the schema excludes: 0 km, 0 minutes, 0 litres', () => {
    const ctx = {} as PennyContext;
    const leg = '00000000-0000-0000-0000-000000000001';
    const route = (data: Record<string, unknown>) =>
      addRouteValidator(ctx).safeParse({ leg_id: leg, data: { label: 'Camp', ...data } }).success;
    expect(route({ distance_km: 0 })).toBe(false);
    expect(route({ distance_km: 0.1 })).toBe(true);
    expect(route({ drive_time_minutes: 0 })).toBe(false);
    expect(route({ drive_time_minutes: 1 })).toBe(true);
    const stop = (data: Record<string, unknown>) =>
      updateStopValidator(ctx).safeParse({ stop_id: leg, data }).success;
    expect(stop({ fuel_amount_l: 0 })).toBe(false);
    expect(stop({ fuel_amount_l: 40 })).toBe(true);
  });
});
