'use client';

import { useState } from 'react';
import Link from 'next/link';
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
   * Driven by the parent's Edit-trips toggle.
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
  /** Called after a successful delete so the parent can remove this card immediately. */
  onDeleted?: (id: number) => void;
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
  onDeleted,
}: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleDeleteConfirm() {
    setBusy(true);
    try {
      await apiFetch(`/api/trips/${id}`, { method: 'DELETE' });
      setShowConfirm(false);
      onDeleted?.(id);
    } catch {
      setBusy(false);
      setShowConfirm(false);
      // API errors surface via the global ErrorNotifier
    }
  }

  return (
    <>
      <div
        style={{
          position: 'relative',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
      >
        <Link
          href={`/trips/${id}`}
          onClick={(e) => {
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
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowConfirm(true);
            }}
            aria-label="Delete trip"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              width: 28,
              height: 28,
              borderRadius: 14,
              background: 'rgba(0,0,0,0.65)',
              border: '1px solid rgba(232,146,124,0.55)',
              color: '#E8927C',
              fontSize: 18,
              lineHeight: 1,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              backdropFilter: 'blur(6px)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            }}
          >
            ×
          </button>
        )}
      </div>

      {showConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '0 20px',
          }}
          onClick={() => !busy && setShowConfirm(false)}
        >
          <div
            style={{
              background: '#1a1a1a',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12,
              padding: 24,
              maxWidth: 320,
              width: '100%',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 8 }}>
              Delete trip?
            </div>
            <div
              style={{
                fontSize: 14,
                color: 'rgba(255,255,255,0.5)',
                marginBottom: 24,
                lineHeight: 1.5,
              }}
            >
              &ldquo;{name}&rdquo; will be permanently deleted.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={busy}
                style={{
                  fontSize: 13,
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: 'transparent',
                  color: 'rgba(255,255,255,0.6)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={busy}
                style={{
                  fontSize: 13,
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#E8927C',
                  color: '#0D0D0D',
                  fontWeight: 600,
                  cursor: busy ? 'default' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  opacity: busy ? 0.7 : 1,
                }}
              >
                {busy && <Spinner size={11} color="#0D0D0D" thickness={2} />}
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
