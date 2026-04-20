'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import TripCard from './TripCard';
import { apiFetch } from '@/lib/api';
import { LoadingOverlay } from '@/components/Spinner';

interface TripSummary {
  id: number;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
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
  const [cloning, setCloning] = useState<number | null>(null);

  async function onCloneClick(id: number) {
    setCloning(id);
    try {
      const trip = await apiFetch<{ id: number }>(`/api/trips/${id}/clone`, { method: 'POST' });
      router.push(`/trips/${trip.id}`);
    } catch (err) {
      console.error(err);
      setCloning(null);
    }
  }

  const hasAnything = myTrips.length > 0 || templates.length > 0;

  return (
    <>
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
              background: editMode ? 'rgba(232,146,124,0.15)' : 'rgba(255,255,255,0.06)',
              color: editMode ? '#E8927C' : 'rgba(255,255,255,0.7)',
              border: editMode
                ? '1px solid rgba(232,146,124,0.45)'
                : '1px solid rgba(255,255,255,0.12)',
              borderRadius: 999,
              padding: '6px 12px',
              cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
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

      {myTrips.length === 0 && (
        <div
          style={{
            padding: 20,
            border: '1px dashed rgba(255,255,255,0.12)',
            borderRadius: 10,
            color: 'rgba(255,255,255,0.5)',
            fontSize: 14,
            marginBottom: 20,
            lineHeight: 1.5,
          }}
        >
          You don&apos;t have any trips yet. Create a new one above, or clone the demo trip below.
        </div>
      )}

      <div className="card-grid">
        {myTrips.map((trip) => (
          <TripCard
            key={trip.id}
            id={trip.id}
            name={trip.name}
            startDate={trip.start_date}
            endDate={trip.end_date}
            status={trip.status}
            editMode={editMode}
          />
        ))}
      </div>

      {templates.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div className="page-eyebrow" style={{ marginBottom: 10 }}>
            DEMO / TEMPLATES
          </div>
          <div className="card-grid">
            {templates.map((trip) => (
              <TripCard
                key={trip.id}
                id={trip.id}
                name={trip.name}
                startDate={trip.start_date}
                endDate={trip.end_date}
                status={trip.status}
                isTemplate
                editMode={editMode && canDeleteTemplates}
                showClone
                onCloneClick={onCloneClick}
                cloneBusy={cloning === trip.id}
              />
            ))}
          </div>
        </div>
      )}

      {cloning != null && <LoadingOverlay message="Cloning trip…" />}
    </>
  );
}
