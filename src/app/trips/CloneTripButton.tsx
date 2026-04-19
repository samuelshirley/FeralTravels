'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';

interface Props {
  tripId: number;
}

export default function CloneTripButton({ tripId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function clone() {
    setBusy(true);
    setErr(null);
    try {
      const trip = await apiFetch<{ id: number }>(`/api/trips/${tripId}/clone`, { method: 'POST' });
      router.push(`/trips/${trip.id}`);
    } catch (e: any) {
      setErr(e?.message || 'Failed to clone');
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={clone}
        disabled={busy}
        style={{
          fontSize: 12,
          background: 'rgba(124,232,163,0.15)',
          border: '1px solid rgba(124,232,163,0.3)',
          color: '#7CE8A3',
          padding: '5px 10px',
          borderRadius: 5,
          cursor: busy ? 'default' : 'pointer',
        }}
      >
        {busy ? 'Cloning…' : 'Clone to my trips'}
      </button>
      {err && <span style={{ fontSize: 11, color: '#E8927C', marginLeft: 8 }}>{err}</span>}
    </>
  );
}
