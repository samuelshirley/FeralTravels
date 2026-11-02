/**
 * Which HTTP status class a failed `usage_events` row carries, read out of its
 * free-text `error_message` — the table has no status column.
 *
 * The writers phrase it three ways, all of which this recognises:
 *   - the Anthropic SDK: the message STARTS with the status (`529 {"type":…`)
 *   - our Google clients: `Directions API returned HTTP 406.`, `… HTTP 403.`
 *   - `status 503`, `status: 429`, `status=500`
 * Anything else (the message gate's `T3 by haiku: …`, the Penny fallback
 * alert) has no HTTP status and is class `none`.
 *
 * ONE pattern, used twice: as a JS RegExp here and as a Postgres `~*` regex in
 * `repos/admin.ts`, so the /admin/errors filter and the tile counts cannot
 * disagree about which row is a 4xx. POSIX and JS agree on every construct in
 * it (groups, alternation, `[0-9]{2}`, anchors); the PGlite round trip in
 * `src/test/pg/admin.test.ts` checks both against the same messages.
 */

export type HttpStatusClass = '4xx' | '5xx' | 'none';
export const HTTP_STATUS_CLASSES: readonly HttpStatusClass[] = ['4xx', '5xx', 'none'] as const;

const PREFIX = '(^|HTTP |status[:= ]+)';
const SUFFIX = '[0-9]{2}([^0-9]|$)';

/** Case-insensitive regex source for one leading digit — `4` or `5`. */
export function statusClassPattern(leading: '4' | '5'): string {
  return `${PREFIX}${leading}${SUFFIX}`;
}

export function httpStatusClassOf(message: string | null | undefined): HttpStatusClass {
  if (!message) return 'none';
  if (new RegExp(statusClassPattern('5'), 'i').test(message)) return '5xx';
  if (new RegExp(statusClassPattern('4'), 'i').test(message)) return '4xx';
  return 'none';
}

export function isHttpStatusClass(v: string | undefined | null): v is HttpStatusClass {
  return v === '4xx' || v === '5xx' || v === 'none';
}
