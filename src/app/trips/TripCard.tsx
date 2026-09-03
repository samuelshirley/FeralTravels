'use client';

import { useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { buttonStyle } from '@/components/ui/Button';

interface Props {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  /** Trip length in days, derived by listTripsForUser. */
  dayCount?: number | null;
  /** Total driving distance in km, derived by listTripsForUser. */
  totalDistanceKm?: number | null;
  /**
   * The next fuel stop on the day the driver is on. Null when there is not one
   * to name — fuel is sourced per-leg on day-open, so a trip nobody has opened
   * has no stop yet. The row is omitted rather than showing a placeholder.
   */
  nextStop?: { name: string; distance_km: number | null } | null;
  /** When true, render the trip card in the "DEMO / TEMPLATES" accent. */
  isTemplate?: boolean;
  /**
   * The trip's last day is behind the user — the card says so and goes quiet.
   * Derived by the caller (lib/tripCompletion) so "today" is resolved once, in
   * the user's own timezone, rather than per card off the server's UTC clock.
   */
  completed?: boolean;
  /**
   * When true, the card reveals a persistent × delete button in the corner.
   * Driven by the parent's Edit-trips toggle.
   */
  editMode?: boolean;
  /**
   * When set, renders a "Clone to my trips" action next to "View". Only
   * meaningful for template cards where the user hasn't started editing
   * their own copy yet.
   */
  showClone?: boolean;
  onCloneClick?: (id: string) => void;
  cloneBusy?: boolean;
  /** Called after a successful delete so the parent can remove this card immediately. */
  onDeleted?: (id: string) => void;
}

export default function TripCard({
  id,
  name,
  startDate,
  endDate,
  dayCount,
  totalDistanceKm,
  nextStop,
  isTemplate = false,
  completed = false,
  editMode = false,
  showClone = false,
  onCloneClick,
  cloneBusy = false,
  onDeleted,
}: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * "16–17 Sep 2026 · 2 days · ~645 km". Each part is dropped when it is not
   * known rather than shown as a zero — a template carries dates and nothing
   * else, and it should read as a date range, not as a 0 km trip.
   */
  const metaBits: string[] = [];
  const dateRange = [startDate, endDate].filter(Boolean).join(' → ');
  if (dateRange) metaBits.push(dateRange);
  if (dayCount) metaBits.push(`${dayCount} day${dayCount === 1 ? '' : 's'}`);
  if (totalDistanceKm) metaBits.push(`~${totalDistanceKm} km`);

  async function handleDeleteConfirm() {
    setBusy(true);
    try {
      await apiFetch(`/api/trips/${id}`, { method: 'DELETE' });
      setShowConfirm(false);
      onDeleted?.(id);
    } catch {
      setBusy(false);
      setShowConfirm(false);
      // API errors surface via the global ErrorNotifier
    }
  }

  return (
    <>
      <div
        data-testid="trip-card"
        data-trip-id={id}
        data-trip-name={name}
        style={{
          position: 'relative',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
      >
        <Link
          href={`/trips/${id}`}
          onClick={(e) => {
            if (editMode) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          style={{
            display: 'block',
            padding: 16,
            // Templates are secondary: a hairline and no fill, so they sit
            // behind the user's own trips instead of competing with them.
            background: isTemplate
              ? 'transparent'
              : completed
                ? 'var(--tp-surface-muted)'
                : 'var(--tp-surface)',
            // Same dimming the itinerary's "behind you" section uses, so a
            // finished trip reads as past on both surfaces.
            opacity: completed ? 0.75 : 1,
            border: isTemplate
              ? '1px solid var(--tp-primary)'
              : editMode
                ? '1px solid var(--tp-border-strong)'
                : '1px solid var(--tp-border)',
            borderRadius: 'var(--tp-radius-lg)',
            color: 'var(--tp-text)',
            textDecoration: 'none',
            transition: 'background 120ms, border-color 120ms',
            boxShadow: isTemplate ? 'none' : 'var(--tp-shadow-sm)',
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 500,
              paddingRight: editMode ? 40 : completed ? 96 : 28,
            }}
          >
            {name}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--tp-subtle)',
              fontVariantNumeric: 'tabular-nums',
              marginTop: 4,
            }}
          >
            {metaBits.join(' · ') || 'No dates set'}
          </div>

          {/*
            The one added line per card. Below a hairline INSIDE the card so it
            reads as a footnote to this trip rather than a second row in the
            list. Omitted entirely when there is no stop to name — see the prop.
          */}
          {nextStop && (
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: '1px solid var(--tp-neutral-900)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: 'var(--tp-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--tp-primary)',
                  flexShrink: 0,
                }}
              />
              Next: fuel at {nextStop.name}
              {nextStop.distance_km != null ? ` · in ${Math.round(nextStop.distance_km)} km` : ''}
            </div>
          )}

          {showClone && !editMode && (
            <div
              className="mobile-wrap"
              style={{ display: 'flex', gap: 8, marginTop: 12 }}
            >
              <span
                style={{
                  ...buttonStyle('secondary'),
                  fontSize: 12,
                  padding: '6px 12px',
                  whiteSpace: 'nowrap',
                }}
              >
                View
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onCloneClick?.(id);
                }}
                disabled={cloneBusy}
                style={{
                  ...buttonStyle(),
                  fontSize: 12,
                  padding: '5px 10px',
                  cursor: cloneBusy ? 'default' : 'pointer',
                  opacity: cloneBusy ? 0.7 : 1,
                }}
              >
                {cloneBusy && <Spinner size={11} color="var(--tp-accent-300)" thickness={2} />}
                {cloneBusy ? 'Cloning…' : 'Clone to my trips'}
              </button>
            </div>
          )}
        </Link>

        {completed && !editMode && (
          <span
            data-testid="trip-completed-badge"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--tp-muted)',
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              borderRadius: 999,
              padding: '3px 8px',
            }}
          >
            Completed
          </span>
        )}

        {editMode && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowConfirm(true);
            }}
            aria-label="Delete trip"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              width: 28,
              height: 28,
              borderRadius: 14,
              background: 'var(--tp-surface)',
              border: '1px solid rgba(198, 93, 74, 0.5)',
              color: 'var(--tp-danger)',
              fontSize: 18,
              lineHeight: 1,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              backdropFilter: 'blur(6px)',
              boxShadow: 'var(--tp-shadow-md)',
            }}
          >
            ×
          </button>
        )}
      </div>

      {showConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--tp-overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '0 20px',
          }}
          onClick={() => !busy && setShowConfirm(false)}
        >
          <div
            style={{
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              borderRadius: 'var(--tp-radius-md)',
              padding: 24,
              maxWidth: 320,
              width: '100%',
              boxShadow: 'var(--tp-shadow-md)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--tp-text)', marginBottom: 8 }}>
              Delete trip?
            </div>
            <div
              style={{
                fontSize: 14,
                color: 'var(--tp-muted)',
                marginBottom: 24,
                lineHeight: 1.5,
              }}
            >
              &ldquo;{name}&rdquo; will be permanently deleted.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={busy}
                style={{
                  fontSize: 13,
                  padding: '8px 16px',
                  borderRadius: 'var(--tp-radius-sm)',
                  border: '1px solid var(--tp-border)',
                  background: 'transparent',
                  color: 'var(--tp-muted)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={busy}
                style={{
                  fontSize: 13,
                  padding: '8px 16px',
                  borderRadius: 'var(--tp-radius-sm)',
                  border: 'none',
                  background: 'var(--tp-danger)',
                  color: 'var(--tp-on-primary)',
                  fontWeight: 600,
                  cursor: busy ? 'default' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  opacity: busy ? 0.7 : 1,
                }}
              >
                {busy && <Spinner size={11} color="var(--tp-on-primary)" thickness={2} />}
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
