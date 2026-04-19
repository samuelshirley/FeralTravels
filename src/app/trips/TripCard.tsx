'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';

interface Props {
  id: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: string;
}

export default function TripCard({ id, name, startDate, endDate, status }: Props) {
  const router = useRouter();
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      // Auto-cancel the confirm state if the user doesn't click again within 3s
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/api/trips/${id}`, { method: 'DELETE' });
      router.refresh();
    } catch (ex: any) {
      setErr(ex?.message || 'Failed to delete');
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setConfirming(false);
      }}
      style={{ position: 'relative' }}
    >
      <Link
        href={`/trips/${id}`}
        style={{
          display: 'block',
          padding: 16,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          color: '#fff',
          textDecoration: 'none',
          transition: 'background 120ms',
          pointerEvents: busy ? 'none' : 'auto',
          opacity: busy ? 0.5 : 1,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, paddingRight: 28 }}>{name}</div>
        <div
          style={{
            fontSize: 12,
            color: 'rgba(255,255,255,0.45)',
            fontFamily: "'JetBrains Mono', monospace",
            marginTop: 4,
          }}
        >
          {[startDate, endDate].filter(Boolean).join(' → ') || 'No dates set'}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            marginTop: 8,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          status: {status}
        </div>
      </Link>

      {(hover || confirming || busy) && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy}
          aria-label={confirming ? 'Confirm delete trip' : 'Delete trip'}
          title={confirming ? 'Click again to confirm' : 'Delete trip'}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: confirming ? 'auto' : 24,
            height: 24,
            padding: confirming ? '0 8px' : 0,
            borderRadius: 12,
            background: confirming ? '#E8927C' : 'rgba(0,0,0,0.55)',
            border: confirming
              ? '1px solid #E8927C'
              : '1px solid rgba(255,255,255,0.15)',
            color: confirming ? '#0D0D0D' : 'rgba(255,255,255,0.85)',
            fontSize: confirming ? 11 : 14,
            fontWeight: confirming ? 700 : 400,
            lineHeight: 1,
            cursor: busy ? 'default' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            transition: 'all 120ms',
            backdropFilter: 'blur(6px)',
          }}
        >
          {busy ? (
            <Spinner size={11} color="#fff" thickness={2} />
          ) : confirming ? (
            'Delete?'
          ) : (
            '×'
          )}
        </button>
      )}

      {err && (
        <div
          style={{
            position: 'absolute',
            bottom: -18,
            left: 0,
            fontSize: 11,
            color: '#E8927C',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}
