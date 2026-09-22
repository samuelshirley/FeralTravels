'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import TripCard from './TripCard';
import { apiFetch } from '@/lib/api';
import { LoadingOverlay } from '@/components/Spinner';
import PullToRefresh from '@/components/PullToRefresh';
import { PencilEditTripsIcon } from '@/components/icons';
import { buttonStyle } from '@/components/ui/buttonStyle';
import { groupByStartDate, type DateGroup } from '@/lib/tripsListDates';

interface TripSummary {
  id: string;
  name: string;
  start_date_parsed: string;
  /** False while the start date is still the today placeholder — no header. */
  start_date_set: boolean;
  status: string;
  /**
   * Resolved on the server (page.tsx) against the user's own timezone. Not
   * derived here: this is a client component, so its clock is whatever the
   * browser says, and two notions of "today" is how the day-drift bug happened.
   */
  completed: boolean;
  /** Derived by listTripsForUser — see the Trip type. */
  day_count?: number | null;
  total_distance_km?: number | null;
  next_stop?: { name: string; distance_km: number | null } | null;
}

interface Props {
  myTrips: TripSummary[];
  templates: TripSummary[];
  /**
   * When true, the delete action is also wired up for template cards
   * (the API still enforces ownership + admin overrides — this just tells
   * the UI to render the X).
   */
  canDeleteTemplates: boolean;
}

export default function TripsList({ myTrips, templates, canDeleteTemplates }: Props) {
  const router = useRouter();
  const [editMode, setEditMode] = useState(false);
  const [cloning, setCloning] = useState<string | null>(null);
  const [myTripsLocal, setMyTripsLocal] = useState(myTrips);
  const [templatesLocal, setTemplatesLocal] = useState(templates);

  function handleTripDeleted(id: string) {
    setMyTripsLocal((prev) => prev.filter((t) => t.id !== id));
    setTemplatesLocal((prev) => prev.filter((t) => t.id !== id));
    router.refresh();
  }

  async function onCloneClick(id: string) {
    setCloning(id);
    try {
      const trip = await apiFetch<{ id: string }>(`/api/trips/${id}/clone`, { method: 'POST' });
      router.push(`/trips/${trip.id}`);
    } catch (err) {
      console.error(err);
      setCloning(null);
    }
  }

  const hasAnything = myTripsLocal.length > 0 || templatesLocal.length > 0;

  // Pull-to-refresh just re-fetches the server component. router.refresh()
  // resolves as soon as Next has re-rendered with fresh data so the
  // spinner stays up the right amount of time.
  const handleRefresh = async () => {
    router.refresh();
    // Small delay so the "Refreshing" label is visible to the user even
    // when the network round trip is fast — otherwise the pull feels
    // like it did nothing.
    await new Promise((r) => setTimeout(r, 350));
  };

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      {hasAnything && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginBottom: 12,
          }}
        >
          <button
            type="button"
            onClick={() => setEditMode((v) => !v)}
            aria-pressed={editMode}
            style={{
              // A neutral outline at rest; the ACTIVE state is the one that
              // has to read at a glance, since it changes what tapping a card
              // does. It takes the accent rather than a second hue.
              ...buttonStyle(editMode ? 'primary' : 'secondary'),
              fontSize: 12,
              borderRadius: 999,
              padding: '6px 12px',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }}
          >
            <PencilEditTripsIcon />
            {editMode ? 'Done' : 'Edit trips'}
          </button>
        </div>
      )}

      {myTripsLocal.length === 0 && (
        <div
          style={{
            padding: 20,
            border: '1px dashed var(--tp-border-strong)',
            borderRadius: 10,
            color: 'var(--tp-muted)',
            fontSize: 14,
            marginBottom: 20,
            lineHeight: 1.5,
            background: 'var(--tp-surface-muted)',
          }}
        >
          You don&apos;t have any trips yet. Use <strong style={{ color: 'var(--tp-text)' }}>+ New trip</strong> above to
          get started.
        </div>
      )}

      <DateGroups
        groups={groupByStartDate(myTripsLocal)}
        renderCard={(trip) => (
          <TripCard
            key={trip.id}
            id={trip.id}
            name={trip.name}
            dayCount={trip.day_count}
            totalDistanceKm={trip.total_distance_km}
            nextStop={trip.next_stop}
            completed={trip.completed}
            editMode={editMode}
            onDeleted={handleTripDeleted}
          />
        )}
      />

      {templatesLocal.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div className="page-eyebrow" style={{ marginBottom: 10 }}>
            DEMO / TEMPLATES
          </div>
          <DateGroups
            groups={groupByStartDate(templatesLocal)}
            renderCard={(trip) => (
              <TripCard
                key={trip.id}
                id={trip.id}
                name={trip.name}
                isTemplate
                editMode={editMode && canDeleteTemplates}
                showClone
                onCloneClick={onCloneClick}
                cloneBusy={cloning === trip.id}
                onDeleted={handleTripDeleted}
              />
            )}
          />
        </div>
      )}

      {cloning != null && <LoadingOverlay message="Cloning trip…" />}
    </PullToRefresh>
  );
}

/**
 * A date header over each run of trips sharing a start date, then their cards
 * (nocturne-reskin §7a). A run with no date to show — the placeholder of a
 * trip still in onboarding — gets its cards and no header.
 */
function DateGroups({
  groups,
  renderCard,
}: {
  groups: DateGroup<TripSummary>[];
  renderCard: (trip: TripSummary) => React.ReactNode;
}) {
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} className="trip-date-group" data-testid="trip-date-group">
          {group.label && (
            <div className="trip-date-header" data-testid="trip-date-header">
              {group.label}
            </div>
          )}
          <div className="card-grid">{group.trips.map(renderCard)}</div>
        </section>
      ))}
    </>
  );
}
