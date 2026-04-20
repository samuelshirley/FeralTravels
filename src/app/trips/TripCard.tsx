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
  /** When true, render the trip card in the "DEMO / TEMPLATES" accent. */
  isTemplate?: boolean;
  /**
   * When true, the card reveals a persistent × delete button in the corner.
   * Driven by the parent's Edit-trips toggle. Replaces the old
   * hover-to-reveal / long-press-to-reveal pattern, which mis-fired on
   * mobile because iOS synthesizes mouseenter events on tap.
   */
  editMode?: boolean;
  /**
   * When set, renders a "Clone to my trips" action next to "View". Only
   * meaningful for template cards where the user hasn't started editing
   * their own copy yet.
   */
  showClone?: boolean;
  onCloneClick?: (id: number) => void;
  cloneBusy?: boolean;
}

export default function TripCard({
  id,
  name,
  startDate,
  endDate,
  status,
  isTemplate = false,
  editMode = false,
  showClone = false,
  onCloneClick,
  cloneBusy = false,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
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
      style={{
        position: 'relative',
        // Still nice to suppress text selection on press-and-hold; the old
        // long-press UX is gone but this keeps card taps feeling crisp.
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
    >
      <Link
        href={`/trips/${id}`}
        onClick={(e) => {
          // In edit mode we treat card taps as "stay here so the user can
          // click the delete X" — navigating would be confusing.
          if (editMode) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        style={{
          display: 'block',
          padding: 16,
          background: isTemplate ? 'rgba(124,181,232,0.05)' : 'rgba(255,255,255,0.04)',
          border: isTemplate
            ? '1px solid rgba(124,181,232,0.2)'
            : editMode
              ? '1px solid rgba(232,146,124,0.35)'
              : '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          color: '#fff',
          textDecoration: 'none',
          transition: 'background 120ms, border-color 120ms',
          pointerEvents: busy ? 'none' : 'auto',
          opacity: busy ? 0.5 : 1,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, paddingRight: editMode ? 40 : 28 }}>
          {name}
        </div>
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

        {showClone && !editMode && (
          <div
            className="mobile-wrap"
            style={{ display: 'flex', gap: 8, marginTop: 12 }}
          >
            <span
              style={{
                fontSize: 12,
                color: '#7CB5E8',
                textDecoration: 'none',
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid rgba(124,181,232,0.3)',
                whiteSpace: 'nowrap',
              }}
            >
              View →
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCloneClick?.(id);
              }}
              disabled={cloneBusy}
              style={{
                fontSize: 12,
                background: 'rgba(124,232,163,0.15)',
                border: '1px solid rgba(124,232,163,0.3)',
                color: '#7CE8A3',
                padding: '5px 10px',
                borderRadius: 5,
                cursor: cloneBusy ? 'default' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                opacity: cloneBusy ? 0.7 : 1,
              }}
            >
              {cloneBusy && <Spinner size={11} color="#7CE8A3" thickness={2} />}
              {cloneBusy ? 'Cloning…' : 'Clone to my trips'}
            </button>
          </div>
        )}
      </Link>

      {editMode && (
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
            width: confirming ? 'auto' : 28,
            height: 28,
            minWidth: 28,
            padding: confirming ? '0 10px' : 0,
            borderRadius: 14,
            background: confirming ? '#E8927C' : 'rgba(0,0,0,0.65)',
            border: confirming
              ? '1px solid #E8927C'
              : '1px solid rgba(232,146,124,0.55)',
            color: confirming ? '#0D0D0D' : '#E8927C',
            fontSize: confirming ? 11 : 18,
            fontWeight: confirming ? 700 : 400,
            lineHeight: 1,
            cursor: busy ? 'default' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            transition: 'all 120ms',
            backdropFilter: 'blur(6px)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
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
