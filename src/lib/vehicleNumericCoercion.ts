/**
 * Drizzle/pg drivers normally return integers and doublePrecision as JS numbers,
 * but we coerce defensively so vehicle completeness checks never mis-read strings
 * or other odd runtime shapes from older rows or drivers.
 */
export function coerceOptionalFiniteNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Integer-ish DB columns → integer or null (rounded from floats). */
export function coerceOptionalInt(raw: unknown): number | null {
  const n = coerceOptionalFiniteNumber(raw);
  if (n == null) return null;
  const r = Math.round(n);
  return Number.isSafeInteger(r) ? r : null;
}
