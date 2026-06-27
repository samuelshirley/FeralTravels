/**
 * Tiny defensive JSON helpers shared by the price adapters. The codebase bans
 * `any`, and provider responses are untrusted external JSON, so we narrow
 * `unknown` explicitly rather than casting.
 */

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
