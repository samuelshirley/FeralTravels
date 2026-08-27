'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import TripCard from './TripCard';
import { apiFetch } from '@/lib/api';
import { LoadingOverlay } from '@/components/Spinner';
import PullToRefresh from '@/components/PullToRefresh';

interface TripSummary {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  /**
   * Resolved on the server (page.tsx) against the user's own timezone. Not
   * derived here: this is a client component, so its clock is whatever the
   * browser says, and two notions of "today" is how the day-drift bug happened.
   */
  completed: boolean;
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
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              background: editMode ? 'var(--tp-accent-warm-muted)' : 'var(--tp-surface-muted)',
              color: editMode ? 'var(--tp-accent-warm)' : 'var(--tp-muted)',
              border: editMode
                ? '1px solid rgba(201, 123, 99, 0.45)'
                : '1px solid var(--tp-border)',
              borderRadius: 999,
              padding: '6px 12px',
              cursor: 'pointer',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
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

      <div className="card-grid">
        {myTripsLocal.map((trip) => (
          <TripCard
            key={trip.id}
            id={trip.id}
            name={trip.name}
            startDate={trip.start_date}
            endDate={trip.end_date}
            completed={trip.completed}
            editMode={editMode}
            onDeleted={handleTripDeleted}
          />
        ))}
      </div>

      {templatesLocal.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div className="page-eyebrow" style={{ marginBottom: 10 }}>
            DEMO / TEMPLATES
          </div>
          <div className="card-grid">
            {templatesLocal.map((trip) => (
              <TripCard
                key={trip.id}
                id={trip.id}
                name={trip.name}
                startDate={trip.start_date}
                endDate={trip.end_date}
                isTemplate
                editMode={editMode && canDeleteTemplates}
                showClone
                onCloneClick={onCloneClick}
                cloneBusy={cloning === trip.id}
                onDeleted={handleTripDeleted}
              />
            ))}
          </div>
        </div>
      )}

      {cloning != null && <LoadingOverlay message="Cloning trip…" />}
    </PullToRefresh>
  );
}
