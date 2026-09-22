'use client';

import { useEffect, useRef, useState } from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react/dist/ssr';

/**
 * A month calendar drawn in the page, for the onboarding date step.
 *
 * It replaces `<input type="date">` + `showPicker()`, which opened the
 * BROWSER's calendar: browser UI, not page content. CSS cannot theme it —
 * `color-scheme` only buys Chrome's generic dark calendar, not Nocturne — and
 * Playwright cannot see it, which is how a white popup on a dark app shipped
 * unnoticed. This one is ordinary DOM on the `--tp-*` tokens, and e2e asserts it.
 *
 * It knows nothing about onboarding: it reports a local `YYYY-MM-DD` and the
 * caller submits it. No minimum date — the native input had none, and a driver
 * already on the road may well answer with yesterday.
 */
export default function CalendarPopover({
  onPick,
  onClose,
  ignoreOutside,
}: {
  onPick: (iso: string) => void;
  onClose: () => void;
  /**
   * The control that opened this. A mousedown on it is not an "outside
   * click", or tapping the chip to close would close-then-reopen.
   */
  ignoreOutside?: React.RefObject<HTMLElement | null>;
}) {
  const today = new Date();
  const todayIso = toIso(today.getFullYear(), today.getMonth(), today.getDate());
  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const rootRef = useRef<HTMLDivElement>(null);

  // Escape and a click anywhere else close it, like PurchaseSheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (ignoreOutside?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, ignoreOutside]);

  // Land keyboard focus on today (or the 1st of another month), so the
  // calendar is usable without a pointer from the moment it opens.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLButtonElement>('button[data-focus-day]')?.focus();
  }, [view]);

  const cells = monthGrid(view.year, view.month);
  const focusIso = cells.includes(todayIso) ? todayIso : toIso(view.year, view.month, 1);
  const title = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
    new Date(view.year, view.month, 1),
  );

  const step = (delta: number) =>
    setView(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  const navStyle: React.CSSProperties = {
    width: 30,
    height: 30,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--tp-border)',
    borderRadius: 'var(--tp-radius-sm)',
    background: 'transparent',
    color: 'var(--tp-text)',
    cursor: 'pointer',
    padding: 0,
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Pick a start date"
      data-testid="onboarding-date-popover"
      style={{
        width: 260,
        maxWidth: '100%',
        boxSizing: 'border-box',
        padding: 12,
        background: 'var(--tp-surface)',
        border: '1px solid var(--tp-border)',
        borderRadius: 'var(--tp-radius-md)',
        boxShadow: 'var(--tp-shadow-md)',
        color: 'var(--tp-text)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <button
          type="button"
          aria-label="Previous month"
          data-testid="onboarding-date-prev"
          onClick={() => step(-1)}
          style={navStyle}
        >
          <CaretLeft size={14} aria-hidden />
        </button>
        <div aria-live="polite" style={{ fontSize: 13, fontWeight: 600 }}>
          {title}
        </div>
        <button
          type="button"
          aria-label="Next month"
          data-testid="onboarding-date-next"
          onClick={() => step(1)}
          style={navStyle}
        >
          <CaretRight size={14} aria-hidden />
        </button>
      </div>

      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}
      >
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            aria-hidden
            style={{ fontSize: 10.5, color: 'var(--tp-subtle)', padding: '2px 0 4px', letterSpacing: '0.04em' }}
          >
            {d}
          </div>
        ))}
        {cells.map((iso, i) =>
          iso === null ? (
            <div key={`blank-${i}`} />
          ) : (
            <button
              key={iso}
              type="button"
              data-testid="onboarding-date-day"
              data-iso={iso}
              data-focus-day={iso === focusIso ? '' : undefined}
              aria-label={dayLabel(iso)}
              aria-current={iso === todayIso ? 'date' : undefined}
              onClick={() => onPick(iso)}
              style={{
                height: 32,
                border: iso === todayIso ? '1px solid var(--tp-primary)' : '1px solid transparent',
                borderRadius: 'var(--tp-radius-sm)',
                background: 'var(--tp-surface-muted)',
                color: 'var(--tp-text)',
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: 'pointer',
                padding: 0,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--tp-primary-muted)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--tp-surface-muted)')}
            >
              {Number(iso.slice(8))}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** Monday first. */
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** A local calendar day as `YYYY-MM-DD` — never via `toISOString`, which is UTC. */
function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * One month as grid cells, Monday first: `null` for the leading blanks, then
 * every day of the month as an ISO string. `month` is 0-based, like `Date`.
 */
export function monthGrid(year: number, month: number): (string | null)[] {
  const leading = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: leading }, () => null);
  for (let d = 1; d <= days; d += 1) cells.push(toIso(year, month, d));
  return cells;
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(y, m - 1, d));
}
