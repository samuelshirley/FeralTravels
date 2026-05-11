'use client';

import { useCallback, useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api';

type Props = {
  tripId: number;
  initial: boolean;
  readonly: boolean;
  onUpdated: () => void;
  compact?: boolean;
};

/**
 * Trip-level hint: server merges `avoid=highways` into Penny get_route when enabled.
 */
export default function TripPreferAvoidHighwaysToggle({
  tripId,
  initial,
  readonly,
  onUpdated,
  compact = false,
}: Props) {
  const [checked, setChecked] = useState(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setChecked(initial);
  }, [initial]);

  const onChange = useCallback(
    async (next: boolean) => {
      if (readonly || busy) return;
      setBusy(true);
      setChecked(next);
      try {
        await apiFetch(`/api/trips/${tripId}`, {
          method: 'PATCH',
          body: { prefer_avoid_highways: next },
        });
        onUpdated();
      } catch {
        setChecked((c) => !c);
      } finally {
        setBusy(false);
      }
    },
    [tripId, readonly, onUpdated],
  );

  if (readonly) return null;

  return (
    <label
      title="Penny will ask Google Directions to omit motorways for this trip (still paved roads; not gravel-only)."
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: compact ? 10 : 11,
        color: 'var(--tp-muted)',
        cursor: busy ? 'wait' : 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="trip-prefer-avoid-highways"
        style={{ accentColor: 'var(--tp-primary)', margin: 0 }}
      />
      {!compact && <span>Avoid motorways</span>}
    </label>
  );
}
