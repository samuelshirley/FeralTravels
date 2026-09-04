'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';
import Button from '@/components/ui/Button';

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
      <Button
        onClick={handleCreate}
        disabled={busy}
        style={{ position: 'relative', padding: '8px 16px', fontSize: 13 }}
      >
        {emphasizeWhenNoTrips && !busy && <span className="new-trip-corner-cue" aria-hidden />}
        {busy && <Spinner size={11} color="var(--tp-accent-300)" thickness={2} />}
        {busy ? 'Creating…' : '+ New trip'}
      </Button>
      {err && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--tp-danger)' }}>
          {err}
        </span>
      )}
    </div>
  );
}
