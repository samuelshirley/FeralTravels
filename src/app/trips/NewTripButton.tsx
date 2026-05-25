'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';

interface NewTripButtonProps {
  /**
   * When true, draw a subtle pulsing rust accent on the button so first-time
   * users notice how to create a trip.
   */
  emphasizeWhenNoTrips?: boolean;
}

/**
 * Creates a trip and jumps straight into its workspace. We no longer ask for a
 * name here — Penny names the trip after building the route (the server assigns
 * a unique "New trip" placeholder until then). The workspace renders mobile as
 * a chat-first view and desktop as the map/itinerary/chat split, so onboarding
 * starts in the right place automatically.
 */
export default function NewTripButton({
  emphasizeWhenNoTrips = false,
}: NewTripButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleCreate() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const trip = await apiFetch<{ id: string }>(`/api/trips`, {
        method: 'POST',
        // No name — the server assigns the placeholder and Penny renames later.
        body: {},
        // We render our own inline error — opt out of the global toast.
        skipGlobalErrorReport: true,
      });
      // Invalidate the /trips RSC cache so the list reflects the new row when
      // the user navigates back from the new trip's workspace.
      router.refresh();
      router.push(`/trips/${trip.id}`);
    } catch (e: any) {
      setErr(e?.message || 'Failed to create trip');
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <button
        type="button"
        onClick={handleCreate}
        disabled={busy}
        aria-busy={busy}
        style={{
          position: 'relative',
          padding: '8px 16px',
          background: 'var(--tp-primary)',
          color: 'var(--tp-on-primary)',
          border: 'none',
          borderRadius: 'var(--tp-radius-sm)',
          fontSize: 13,
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
          boxShadow: 'var(--tp-shadow-sm)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {emphasizeWhenNoTrips && !busy && <span className="new-trip-corner-cue" aria-hidden />}
        {busy && <Spinner size={11} color="var(--tp-on-primary)" thickness={2} />}
        {busy ? 'Creating…' : '+ New trip'}
      </button>
      {err && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--tp-danger)' }}>
          {err}
        </span>
      )}
    </div>
  );
}
