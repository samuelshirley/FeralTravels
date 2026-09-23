/**
 * The onboarding calendar's date maths, shared by both calendars.
 *
 * `src/components/CalendarPopover.tsx` (web) and
 * `mobile/components/CalendarPopover.tsx` (native) draw the same month and
 * report the same day. They import every "which day is this" decision from
 * here, so the two cannot drift — off by one at a month boundary, or shifted to
 * UTC on one platform only. Mirrored into `mobile/shared/` by
 * `scripts/sync-shared.mjs`; DOM-free and React-free on purpose.
 *
 * Months are 0-based, like `Date`. Every date is LOCAL: nothing here goes
 * through `toISOString`, which is UTC and turns a late-evening local day into
 * tomorrow west of Greenwich, or an early-morning one into yesterday east of it.
 */

/** Column headers, Monday first. */
export const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

/** A local calendar day as `YYYY-MM-DD`. */
export function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The local calendar day `date` falls on, as `YYYY-MM-DD`. */
export function localIso(date: Date): string {
  return toIso(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * One month as grid cells, Monday first: `null` for the leading blanks, then
 * every day of the month as an ISO string.
 */
export function monthGrid(year: number, month: number): (string | null)[] {
  const leading = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: leading }, () => null);
  for (let d = 1; d <= days; d += 1) cells.push(toIso(year, month, d));
  return cells;
}

/** The month `delta` months from `view`, rolling the year over. */
export function stepMonth(
  view: { year: number; month: number },
  delta: number,
): { year: number; month: number } {
  const d = new Date(view.year, view.month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** `December 2026` — the calendar's title. */
export function monthTitle(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
    new Date(year, month, 1),
  );
}

/** `Friday, January 15, 2027` — a day cell's accessible name. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(y, m - 1, d));
}

/** The day-of-month a cell shows: `2026-10-05` → `5`. */
export function dayNumber(iso: string): number {
  return Number(iso.slice(8));
}
