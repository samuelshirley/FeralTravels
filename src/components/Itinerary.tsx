'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TripWithLegs } from '@/types/trip';
import { apiFetch } from '@/lib/api';
import { formatDate, parseISODate, behindCutoffRank, todayISO } from '@/lib/dates';
import { isTripCompleted, lastDayFromLegDates } from '@/lib/tripCompletion';
import { effectiveLegSegment } from '@/lib/legSegmentGrouping';
import { useUnits } from './UnitsContext';
import LegCard from './LegCard';
import Distance from './Distance';

// Pagination tuning. The first chunk is sized so a 20-day trip fits in a
// single render (matches the user-facing "20 days" model). Subsequent
// chunks are smaller so the loading shimmer feels like progress, not a
// long pause. Increase if profiling shows the IntersectionObserver firing
// too aggressively on fast scrolls.
const INITIAL_VISIBLE_LEGS = 20;
const INCREMENTAL_BATCH_SIZE = 10;
/** Breathing room after the last leg so the pane scrolls past the final card. */
const ITINERARY_SCROLL_END_INSET = 48;
// Brief artificial pause before revealing each new batch so the user
// perceives that something happened — instant rendering reads as "broken"
// to the modern eye even when it's correct.
const BATCH_REVEAL_DELAY_MS = 220;

interface ItineraryProps {
  tripId: string;
  trip: TripWithLegs;
  onLegSelect: (legId: string) => void;
  onTrailsChanged?: () => void;
  onChanged?: () => void;
  readonly?: boolean;
  /**
   * True while the trip's auto fuel-replan is in flight. Forwarded to each
   * LegCard so the per-leg "Open in Google Maps" button can show a syncing
   * affordance — the URL composes its waypoints from current stops, which
   * are briefly stale during a replan.
   */
  isFuelSyncing?: boolean;
  /**
   * Set when the user clicks a leg or stop marker on the map. We expand the
   * owning leg (revealing it past the lazy window / "behind you" fold if
   * needed) and scroll the leg — or the specific stop — into view. The nonce
   * lets a repeat click on the same target re-trigger the scroll.
   */
  focusTarget?: { legId: string; stopId: string | null; nonce: number } | null;
}

export default function Itinerary({
  tripId,
  trip,
  onLegSelect,
  onTrailsChanged,
  onChanged,
  readonly = false,
  isFuelSyncing = false,
  focusTarget = null,
}: ItineraryProps) {
  const allLegs = trip.legs;
  // Driver progress splits the itinerary into "behind you" (completed) and the
  // legs from here forward. We anchor the list at the current leg and tuck past
  // days behind a collapsible header so opening the trip shows where the driver
  // is NOW at the top.
  //
  // Two signals feed the cutoff (see behindCutoffRank), combined as a max:
  //   1. The calendar — legs dated strictly before today are past.
  //   2. An explicit reportPosition (trip.current_leg_id) — a floor, so we never
  //      collapse a leg the driver said they'd reached. It does NOT freeze the
  //      view: the calendar advances past a stale report as real days pass.
  // So a trip opened mid-journey collapses elapsed days automatically, even if
  // the last position report is days old.
  const reportedRank = trip.current_leg_id
    ? allLegs.findIndex((l) => l.id === trip.current_leg_id)
    : -1;
  // A trip whose last day has passed has nothing ahead of it. Every day goes
  // behind the fold and the list above it renders empty — no "0 days left"
  // summary, no prompt to do anything. behindCutoffRank deliberately keeps the
  // final leg visible so a live trip's list is never empty; that guard is what
  // we're overriding here, and only here.
  const completed = isTripCompleted(
    lastDayFromLegDates(allLegs.map((l) => l.date_iso)),
    todayISO(),
  );
  const currentRank = completed
    ? allLegs.length
    : behindCutoffRank({
        reportedRank,
        legDateISOs: allLegs.map((l) => l.date_iso),
        todayISO: todayISO(),
      });
  const pastLegs = currentRank > 0 ? allLegs.slice(0, currentRank) : [];
  const legs = currentRank > 0 ? allLegs.slice(currentRank) : allLegs;
  const { units } = useUnits();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showPast, setShowPast] = useState(false);
  // Stop id to briefly ring after a map marker click, so the user's eye lands
  // on the right card. Cleared on a timer.
  const [highlightStopId, setHighlightStopId] = useState<string | null>(null);

  // Compute a date label for each leg from the trip's confirmed start date.
  // Returns a Map<legId, formattedDate> so LegCard can display real calendar
  // dates. Every leg has one — the start date is a hard invariant.
  // The calendar date for each leg is computed server-side (leg.date_iso).
  // Here we only format it for the user's locale preference — no date math.
  const legDateLabels = useMemo(() => {
    const map = new Map<string, string>();
    // Every leg has a date_iso — the trip start date is a hard invariant.
    for (const leg of allLegs) {
      map.set(leg.id, formatDate(parseISODate(leg.date_iso), units));
    }
    return map;
  }, [allLegs, units]);

  // ── Lazy rendering ─────────────────────────────────────────────────────
  // We mount the first INITIAL_VISIBLE_LEGS leg cards and reveal more in
  // batches as the user scrolls past a sentinel near the bottom. The
  // server-side replan / data-fetching is unchanged — this is purely about
  // not paying React reconciliation cost for cards no one is looking at.
  // Trips with <= INITIAL_VISIBLE_LEGS render everything immediately.
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(legs.length, INITIAL_VISIBLE_LEGS),
  );
  const [revealing, setRevealing] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Inline trip-name edit ──────────────────────────────────────────────
  // The app auto-names the trip; this lets the user override that name in
  // place. Clicking the pencil swaps the title for a text input; saving
  // PATCHes the name and refreshes via onChanged.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(trip.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the draft in sync when the persisted name changes (e.g. Penny renamed
  // it) while we're not actively editing.
  useEffect(() => {
    if (!editingName) setNameDraft(trip.name);
  }, [trip.name, editingName]);

  const startEditingName = () => {
    setNameDraft(trip.name);
    setNameError(null);
    setEditingName(true);
  };

  const cancelEditingName = () => {
    setEditingName(false);
    setNameError(null);
    setNameDraft(trip.name);
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next) {
      setNameError('Name cannot be empty');
      return;
    }
    if (next === trip.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      await apiFetch(`/api/trips/${tripId}`, {
        method: 'PATCH',
        body: { name: next },
        skipGlobalErrorReport: true,
      });
      setEditingName(false);
      onChanged?.();
    } catch (err) {
      setNameError(
        err instanceof Error && err.message ? err.message : 'Could not save name',
      );
    } finally {
      setSavingName(false);
    }
  };

  // Focus + select the input when entering edit mode.
  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  // Keep visibleCount in sync as legs are added/removed underneath us. If
  // the trip grew, we don't auto-reveal — let the IO trigger that. If the
  // trip shrank below visibleCount, clamp down so we don't try to render
  // past the array.
  useEffect(() => {
    setVisibleCount((current) => Math.min(current, legs.length) || legs.length);
  }, [legs.length]);

  // Cleanup any pending reveal timer on unmount so a late tick doesn't
  // setState after the component is gone.
  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    if (visibleCount >= legs.length) return; // nothing more to reveal

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (revealTimerRef.current) return; // already scheduled
          setRevealing(true);
          revealTimerRef.current = setTimeout(() => {
            setVisibleCount((c) =>
              Math.min(legs.length, c + INCREMENTAL_BATCH_SIZE),
            );
            setRevealing(false);
            revealTimerRef.current = null;
          }, BATCH_REVEAL_DELAY_MS);
        }
      },
      { rootMargin: '120px 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [visibleCount, legs.length]);

  // ── Map-marker focus → open in list ────────────────────────────────────
  // When the user clicks a leg/stop marker on the map, expand the owning leg
  // (revealing it past the lazy window or the "behind you" fold first), then
  // scroll the leg — or the exact stop — into view and briefly ring it. Keyed
  // on the focus nonce so a repeat click on the same target re-fires.
  useEffect(() => {
    if (!focusTarget) return;
    const { legId, stopId } = focusTarget;
    const allIdx = allLegs.findIndex((l) => l.id === legId);
    if (allIdx === -1) return;

    if (currentRank > 0 && allIdx < currentRank) {
      // The leg is in the collapsed "behind you" section — open it.
      setShowPast(true);
    } else {
      // Ensure it's within the lazily-revealed window so the card is mounted.
      const fwdIdx = currentRank > 0 ? allIdx - currentRank : allIdx;
      setVisibleCount((c) => Math.max(c, fwdIdx + 1));
    }

    setExpanded((prev) => {
      if (prev.has(legId)) return prev;
      const next = new Set(prev);
      next.add(legId);
      return next;
    });
    setHighlightStopId(stopId);

    // Wait for the expand/reveal to render, then scroll the target into view.
    const scrollTimer = setTimeout(() => {
      const sel = stopId
        ? `[data-stop-anchor="${stopId}"]`
        : `[data-leg-id="${CSS.escape(legId)}"]`;
      const el = document.querySelector(sel) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 90);

    const clearHighlight = setTimeout(() => setHighlightStopId(null), 2200);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearHighlight);
    };
    // Intentionally keyed on the nonce only: allLegs/currentRank are read fresh
    // at click time, and we don't want trip reloads to re-trigger a scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget?.nonce]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Expand-All implies "show me everything" — reveal all legs in addition to
  // expanding their cards. Otherwise users would click Expand All and only
  // see the first 20 cards expanded with the rest still hidden behind the
  // sentinel.
  const expandAll = () => {
    setVisibleCount(legs.length);
    setExpanded(new Set(legs.map((l) => l.id)));
  };
  const collapseAll = () => setExpanded(new Set());

  const visibleLegs = legs.slice(0, visibleCount);
  const hiddenCount = legs.length - visibleCount;

  // ── Segment grouping ───────────────────────────────────────────────────
  // Each leg row is a *driving day* in user terms. When Penny has tagged
  // legs with a segment_index, we may render them grouped under segment
  // headers — but only if the trip is large enough that grouping helps,
  // per the user's rule: "more than 20 days OR more than 5 segments".
  // Trips smaller than that always render as a flat day list, even when
  // segment data exists.
  const distinctSegments = new Set(
    legs.map((l) => l.segment_index).filter((i): i is number => i != null),
  ).size;
  const shouldGroup =
    distinctSegments > 0 && (legs.length > 20 || distinctSegments > 5);

  // Walk visibleLegs and bucket consecutive same-segment legs together.
  // Legs whose segment_index is null become single-leg "loose" groups so
  // they slot into the order they were authored in (rather than a catch-all
  // bucket at the end). Penny is expected to set segments consistently when
  // she sets them at all, so loose legs in a grouped trip should be rare.
  type LegGroup = {
    key: string;
    segmentIndex: number | null;
    segmentName: string | null;
    legs: typeof visibleLegs;
  };
  const groups: LegGroup[] = [];
  if (shouldGroup) {
    const preceding: typeof visibleLegs = [];
    for (const leg of visibleLegs) {
      const effective = effectiveLegSegment(leg, preceding);
      preceding.push(leg);
      const last = groups[groups.length - 1];
      if (
        last &&
        last.segmentIndex === effective.segment_index &&
        effective.segment_index != null
      ) {
        last.legs.push(leg);
      } else {
        groups.push({
          key: `${effective.segment_index ?? `loose-${leg.id}`}`,
          segmentIndex: effective.segment_index,
          segmentName: effective.segment_name,
          legs: [leg],
        });
      }
    }
  }

  const totalDist = allLegs.reduce((sum, l) => sum + (l.distance_km || 0), 0);
  const drivingDays = allLegs.filter((l) => (l.leg_type ?? 'drive') !== 'rest').length;
  const restDays = allLegs.filter((l) => (l.leg_type ?? 'drive') === 'rest').length;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.15em',
            color: 'var(--tp-subtle)',
            marginBottom: 6,
          }}
        >
          ROUTE PLAN
          {completed && (
            <span style={{ marginLeft: 8, color: 'var(--tp-muted)' }}>· COMPLETED</span>
          )}
          {readonly && (
            <span style={{ marginLeft: 8, color: 'var(--tp-primary)' }}>
              · DEMO (read-only — clone to edit)
            </span>
          )}
        </div>
        {editingName ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                ref={nameInputRef}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveName();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEditingName();
                  }
                }}
                maxLength={200}
                disabled={savingName}
                data-testid="trip-name-input"
                aria-label="Trip name"
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  color: 'var(--tp-text)',
                  background: 'var(--tp-surface)',
                  border: '1px solid var(--tp-border)',
                  borderRadius: 6,
                  padding: '2px 8px',
                  maxWidth: '100%',
                  width: 'min(420px, 100%)',
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={() => void saveName()}
                disabled={savingName}
                data-testid="trip-name-save"
                aria-label="Save name"
                style={{
                  background: 'var(--tp-primary)',
                  border: 'none',
                  color: '#fff',
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: savingName ? 'wait' : 'pointer',
                }}
              >
                {savingName ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={cancelEditingName}
                disabled={savingName}
                aria-label="Cancel"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--tp-border)',
                  color: 'var(--tp-muted)',
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
            {nameError && (
              <div style={{ fontSize: 12, color: 'var(--tp-danger, #c0392b)', marginTop: 6 }}>
                {nameError}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1
              style={{
                fontSize: 24,
                fontWeight: 700,
                margin: 0,
                lineHeight: 1.2,
                color: 'var(--tp-text)',
              }}
            >
              {trip.name}
            </h1>
            {!readonly && (
              <button
                onClick={startEditingName}
                data-testid="trip-name-edit"
                aria-label="Rename trip"
                title="Rename trip"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--tp-subtle)',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: 4,
                  lineHeight: 0,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                </svg>
              </button>
            )}
          </div>
        )}
        {(trip.start_date || trip.end_date) && (
          <div style={{ fontSize: 13, color: 'var(--tp-muted)', marginTop: 6 }}>
            {[trip.start_date, trip.end_date].filter(Boolean).join(' → ')}
          </div>
        )}

        <div style={{ display: 'flex', gap: 20, marginTop: 14, flexWrap: 'wrap' }}>
          {([
            // Primary total uses Distance so imperial users see the (X mi)
            // secondary line under the km value.
            {
              label: 'TOTAL',
              value: (
                <Distance
                  km={totalDist}
                  primaryOverride={`~${totalDist.toLocaleString()} km`}
                />
              ),
            },
            // Show total days, with driving/rest breakdown when rest days exist.
            ...(restDays > 0
              ? [
                  { label: 'TOTAL DAYS', value: `${allLegs.length}` as React.ReactNode },
                  { label: 'DRIVING', value: `${drivingDays}` as React.ReactNode },
                  { label: 'REST', value: `${restDays}` as React.ReactNode },
                ]
              : [{ label: 'DAYS', value: `${allLegs.length}` as React.ReactNode }]),
          ] as Array<{ label: string; value: React.ReactNode }>).map((s, i) => (
            <div key={i}>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: 'var(--tp-subtle)',
                }}
              >
                {s.label}
              </div>
              <div
                style={{ fontSize: 14, fontWeight: 600, color: 'var(--tp-text)', marginTop: 2 }}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Controls — they act on the days ahead, so a completed trip has none. */}
      {!completed && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={expandAll}
            style={{
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              color: 'var(--tp-muted)',
              padding: '5px 12px',
              borderRadius: 4,
              fontSize: 11,
              cursor: 'pointer',
            
            }}
          >
            Expand All
          </button>
          <button
            onClick={collapseAll}
            style={{
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              color: 'var(--tp-muted)',
              padding: '5px 12px',
              borderRadius: 4,
              fontSize: 11,
              cursor: 'pointer',
            
            }}
          >
            Collapse All
          </button>
        </div>
      )}

      {/* Past days, collapsed by default so the trip opens at where the driver
          actually is. On a live trip the header says "behind you" rather than
          "completed": the cutoff is positional (calendar/report), not proof the
          driver finished those days. On a completed trip it is the only thing
          left on the page, so it reads as the disclosure it now is. */}
      {pastLegs.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={() => setShowPast((v) => !v)}
            style={{
              width: '100%',
              textAlign: 'left',
              background: 'var(--tp-surface-muted)',
              border: '1px dashed var(--tp-border)',
              color: 'var(--tp-muted)',
              padding: '8px 12px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {showPast ? '▾' : '▸'}{' '}
            {completed
              ? `${showPast ? 'Hide' : 'Show'} past days — ${pastLegs.length} day${
                  pastLegs.length === 1 ? '' : 's'
                }`
              : `Behind you — ${pastLegs.length} earlier day${
                  pastLegs.length === 1 ? '' : 's'
                }`}
          </button>
          {showPast && (
            <div
              style={{
                border: '1px solid var(--tp-border)',
                borderRadius: 10,
                overflow: 'hidden',
                background: 'var(--tp-surface)',
                marginTop: 8,
                opacity: 0.75,
              }}
            >
              {pastLegs.map((leg) => (
                <LegCard
                  key={leg.id}
                  tripId={tripId}
                  leg={leg}
                  expanded={expanded.has(leg.id)}
                  onToggle={() => toggle(leg.id)}
                  onNavigate={() => onLegSelect(leg.id)}
                  onTrailsChanged={onTrailsChanged}
                  onChanged={onChanged}
                  readonly={readonly}
                  dateLabel={legDateLabels.get(leg.id)}
                  isFuelSyncing={isFuelSyncing}
                  fuelSyncTotalLegs={allLegs.length}
                  highlightStopId={highlightStopId}
                  isPast
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Leg cards — flat or grouped by segment */}
      {shouldGroup ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {groups.map((group) => {
            const groupKm = group.legs.reduce(
              (sum, l) => sum + (l.distance_km || 0),
              0,
            );
            const isLoose = group.segmentIndex === null;
            return (
              <div key={group.key}>
                {/*
                  Segment header. Looks like a small section title, not a
                  full chrome card — the leg cards underneath carry the
                  visual weight. Loose legs (no segment tagged) get a
                  dimmer, non-numbered header so they read as "uncatalogued"
                  rather than as their own equal-weight segment.
                */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    padding: '0 4px 8px 4px',
                    borderBottom: '1px solid var(--tp-border)',
                    marginBottom: 8,
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.18em',
                      color: 'var(--tp-subtle)',
                      textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isLoose
                      ? 'OTHER'
                      : `LEG ${(group.segmentIndex ?? 0) + 1}`}
                  </div>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: isLoose ? 'var(--tp-muted)' : 'var(--tp-text)',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {group.segmentName ?? '—'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--tp-subtle)',
                      whiteSpace: 'nowrap',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 6,
                    }}
                  >
                    <span>
                      {group.legs.length} day{group.legs.length === 1 ? '' : 's'}
                    </span>
                    {groupKm > 0 && (
                      <>
                        <span>·</span>
                        <Distance
                          km={Math.round(groupKm)}
                          layout="inline"
                          primaryOverride={`~${Math.round(groupKm).toLocaleString()} km`}
                        />
                      </>
                    )}
                  </div>
                </div>
                <div
                  style={{
                    border: '1px solid var(--tp-border)',
                    borderRadius: 10,
                    overflow: 'hidden',
                    background: 'var(--tp-surface)',
                    boxShadow: 'var(--tp-shadow-sm)',
                  }}
                >
                  {group.legs.map((leg) => (
                    <LegCard
                      key={leg.id}
                      tripId={tripId}
                      leg={leg}
                      expanded={expanded.has(leg.id)}
                      onToggle={() => toggle(leg.id)}
                      onNavigate={() => onLegSelect(leg.id)}
                      onTrailsChanged={onTrailsChanged}
                      onChanged={onChanged}
                      readonly={readonly}
                      dateLabel={legDateLabels.get(leg.id)}
                      isFuelSyncing={isFuelSyncing}
                      fuelSyncTotalLegs={legs.length}
                      highlightStopId={highlightStopId}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--tp-border)',
            borderRadius: 10,
            overflow: 'hidden',
            background: 'var(--tp-surface)',
            boxShadow: 'var(--tp-shadow-sm)',
          }}
        >
          {visibleLegs.map((leg) => (
            <LegCard
              key={leg.id}
              tripId={tripId}
              leg={leg}
              expanded={expanded.has(leg.id)}
              onToggle={() => toggle(leg.id)}
              onNavigate={() => onLegSelect(leg.id)}
              onTrailsChanged={onTrailsChanged}
              onChanged={onChanged}
              readonly={readonly}
              dateLabel={legDateLabels.get(leg.id)}
              isFuelSyncing={isFuelSyncing}
              fuelSyncTotalLegs={legs.length}
              highlightStopId={highlightStopId}
            />
          ))}
        </div>
      )}

      {/*
        Sentinel + reveal skeleton. Only renders when there are still legs
        below the fold. The skeleton (three pulsing bars) is intentionally
        boring — it conveys "loading more, please wait" without competing
        with the real content above. We show "Loading N more leg(s)…" so the
        user knows roughly what's coming.
      */}
      {hiddenCount > 0 && (
        <div ref={sentinelRef} style={{ marginTop: 14 }}>
          <div
            aria-live="polite"
            style={{
              padding: '14px 16px',
              border: '1px dashed var(--tp-border)',
              borderRadius: 10,
              background: 'var(--tp-surface-muted)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              opacity: revealing ? 1 : 0.7,
              transition: 'opacity 200ms ease',
            }}
          >
            <div
              style={{
                fontSize: 11,
                letterSpacing: '0.08em',
                color: 'var(--tp-muted)',
                fontWeight: 600,
                textTransform: 'uppercase',
              }}
            >
              Loading {Math.min(hiddenCount, INCREMENTAL_BATCH_SIZE)} more leg
              {Math.min(hiddenCount, INCREMENTAL_BATCH_SIZE) === 1 ? '' : 's'}…
              {hiddenCount > INCREMENTAL_BATCH_SIZE && (
                <span style={{ color: 'var(--tp-subtle)', marginLeft: 6 }}>
                  ({hiddenCount} remaining)
                </span>
              )}
            </div>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="tp-skeleton-bar"
                style={{
                  height: 12,
                  borderRadius: 4,
                  width: `${100 - i * 18}%`,
                  background:
                    'linear-gradient(90deg, var(--tp-border) 0%, var(--tp-border-strong) 50%, var(--tp-border) 100%)',
                  backgroundSize: '200% 100%',
                  animation: 'tp-skeleton-shimmer 1.4s ease-in-out infinite',
                  animationDelay: `${i * 120}ms`,
                }}
              />
            ))}
          </div>
          <style jsx>{`
            @keyframes tp-skeleton-shimmer {
              0% {
                background-position: 200% 0;
              }
              100% {
                background-position: -200% 0;
              }
            }
          `}</style>
        </div>
      )}

      {/* Explicit scroll tail — padding on the pane scroller alone is unreliable
          inside flex/resizable panels, so this spacer is part of scroll content. */}
      <div aria-hidden="true" style={{ height: ITINERARY_SCROLL_END_INSET }} />
    </div>
  );
}
