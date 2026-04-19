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
          background: '#7CB5E8',
          color: '#000',
          border: 'none',
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
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
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          color: '#fff',
          fontSize: 13,
          outline: 'none',
        }}
      />
      <button
        onClick={handleCreate}
        disabled={busy || !name.trim()}
        style={{
          padding: '8px 14px',
          background: busy ? 'rgba(255,255,255,0.1)' : '#7CB5E8',
          color: busy ? '#fff' : '#000',
          border: 'none',
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {busy && <Spinner size={11} color="#7CB5E8" thickness={2} />}
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
          color: 'rgba(255,255,255,0.5)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Cancel
      </button>
      {err && <span style={{ fontSize: 12, color: '#E8927C' }}>{err}</span>}
      {busy && <LoadingOverlay message="Creating trip…" />}
    </div>
  );
}
