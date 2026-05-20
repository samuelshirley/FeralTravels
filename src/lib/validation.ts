/**
 * Shared validation helpers for API routes.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the input string if it's a valid UUID v4 format, otherwise null.
 * Use for URL params and query string IDs that were previously parsed with parseInt.
 */
export function parseUUID(raw: string): string | null {
  return UUID_RE.test(raw) ? raw : null;
}
