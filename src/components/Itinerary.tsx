'use client';

import { useState } from 'react';
import type { TripWithLegs } from '@/types/trip';
import LegCard from './LegCard';

interface ItineraryProps {
  tripId: number;
  trip: TripWithLegs;
  onLegSelect: (legId: number) => void;
  onTrailsChanged?: () => void;
  onChanged?: () => void;
  readonly?: boolean;
}

export default function Itinerary({
  tripId,
  trip,
  onLegSelect,
  onTrailsChanged,
  onChanged,
  readonly = false,
}: ItineraryProps) {
  const legs = trip.legs;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
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

  const expandAll = () => setExpanded(new Set(legs.map((l) => l.id)));
  const collapseAll = () => setExpanded(new Set());

  const totalDist = legs.reduce((sum, l) => sum + (l.distance_km || 0), 0);

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
          {readonly && (
            <span style={{ marginLeft: 8, color: 'var(--tp-primary)' }}>
              · DEMO (read-only — clone to edit)
            </span>
          )}
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, lineHeight: 1.2, color: 'var(--tp-text)' }}>{trip.name}</h1>
        {(trip.start_date || trip.end_date) && (
          <div style={{ fontSize: 13, color: 'var(--tp-muted)', marginTop: 6 }}>
            {[trip.start_date, trip.end_date].filter(Boolean).join(' → ')}
          </div>
        )}

        <div style={{ display: 'flex', gap: 20, marginTop: 14, flexWrap: 'wrap' }}>
          {[
            { label: 'TOTAL', value: `~${totalDist.toLocaleString()} km` },
            { label: 'LEGS', value: `${legs.length}` },
            { label: 'STATUS', value: trip.status },
          ].map((s, i) => (
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

      {/* Controls */}
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

      {/* Leg cards */}
      <div
        style={{
          border: '1px solid var(--tp-border)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'var(--tp-surface)',
          boxShadow: 'var(--tp-shadow-sm)',
        }}
      >
        {legs.map((leg) => (
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
          />
        ))}
      </div>
    </div>
  );
}
