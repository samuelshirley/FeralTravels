'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import Spinner, { LoadingOverlay } from '@/components/Spinner';

export default function NewTripButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const trip = await apiFetch<{ id: number }>(`/api/trips`, {
        method: 'POST',
        body: { name: name.trim() },
      });
      // Invalidate the /trips RSC cache so when the user navigates back from
      // the new trip's workspace, the list reflects the new row. Without this,
      // Next's client-side navigation cache serves the pre-create render and
      // the list looks stale until an unrelated mutation (e.g. delete) forces
      // a refresh.
      router.refresh();
      router.push(`/trips/${trip.id}`);
    } catch (e: any) {
      setErr(e?.message || 'Failed to create trip');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          padding: '8px 16px',
          background: 'var(--tp-primary)',
          color: 'var(--tp-on-primary)',
          border: 'none',
          borderRadius: 'var(--tp-radius-sm)',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: 'var(--tp-shadow-sm)',
        }}
      >
        + New trip
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCreate();
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Trip name"
        style={{
          padding: '8px 12px',
          background: 'var(--tp-surface-muted)',
          border: '1px solid var(--tp-border)',
          borderRadius: 'var(--tp-radius-sm)',
          color: 'var(--tp-text)',
          fontSize: 13,
          outline: 'none',
        }}
      />
      <button
        onClick={handleCreate}
        disabled={busy || !name.trim()}
        style={{
          padding: '8px 14px',
          background: busy ? 'var(--tp-border)' : 'var(--tp-primary)',
          color: busy ? 'var(--tp-muted)' : 'var(--tp-on-primary)',
          border: 'none',
          borderRadius: 'var(--tp-radius-sm)',
          fontSize: 13,
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {busy && <Spinner size={11} color="var(--tp-primary)" thickness={2} />}
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button
        onClick={() => {
          setOpen(false);
          setName('');
        }}
        style={{
          padding: '8px 12px',
          background: 'transparent',
          color: 'var(--tp-muted)',
          border: '1px solid var(--tp-border)',
          borderRadius: 'var(--tp-radius-sm)',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Cancel
      </button>
      {err && <span style={{ fontSize: 12, color: 'var(--tp-danger)' }}>{err}</span>}
      {busy && <LoadingOverlay message="Creating trip…" />}
    </div>
  );
}
