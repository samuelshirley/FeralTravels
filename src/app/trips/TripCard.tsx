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
            background: isTemplate ? 'var(--tp-primary-muted)' : 'var(--tp-surface)',
            border: isTemplate
              ? '1px solid rgba(78, 122, 176, 0.28)'
              : editMode
                ? '1px solid rgba(201, 123, 99, 0.45)'
                : '1px solid var(--tp-border)',
            borderRadius: 'var(--tp-radius-md)',
            color: 'var(--tp-text)',
            textDecoration: 'none',
            transition: 'background 120ms, border-color 120ms',
            boxShadow: 'var(--tp-shadow-sm)',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, paddingRight: editMode ? 40 : 28 }}>
            {name}
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--tp-muted)',
              
              marginTop: 4,
            }}
          >
            {[startDate, endDate].filter(Boolean).join(' → ') || 'No dates set'}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--tp-subtle)',
              marginTop: 8,
              
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
                  color: 'var(--tp-primary)',
                  textDecoration: 'none',
                  padding: '6px 12px',
                  borderRadius: 'var(--tp-radius-sm)',
                  border: '1px solid var(--tp-primary-muted)',
                  whiteSpace: 'nowrap',
                  background: 'var(--tp-surface-muted)',
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
                  background: 'var(--tp-success-muted)',
                  border: '1px solid rgba(74, 139, 122, 0.35)',
                  color: 'var(--tp-success)',
                  padding: '5px 10px',
                  borderRadius: 'var(--tp-radius-sm)',
                  cursor: cloneBusy ? 'default' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  opacity: cloneBusy ? 0.7 : 1,
                }}
              >
                {cloneBusy && <Spinner size={11} color="var(--tp-success)" thickness={2} />}
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
              background: 'var(--tp-surface)',
              border: '1px solid rgba(198, 93, 74, 0.5)',
              color: 'var(--tp-danger)',
              fontSize: 18,
              lineHeight: 1,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              backdropFilter: 'blur(6px)',
              boxShadow: 'var(--tp-shadow-md)',
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
            background: 'var(--tp-overlay)',
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
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              borderRadius: 'var(--tp-radius-md)',
              padding: 24,
              maxWidth: 320,
              width: '100%',
              boxShadow: 'var(--tp-shadow-md)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--tp-text)', marginBottom: 8 }}>
              Delete trip?
            </div>
            <div
              style={{
                fontSize: 14,
                color: 'var(--tp-muted)',
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
                  borderRadius: 'var(--tp-radius-sm)',
                  border: '1px solid var(--tp-border)',
                  background: 'transparent',
                  color: 'var(--tp-muted)',
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
                  borderRadius: 'var(--tp-radius-sm)',
                  border: 'none',
                  background: 'var(--tp-danger)',
                  color: 'var(--tp-on-primary)',
                  fontWeight: 600,
                  cursor: busy ? 'default' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  opacity: busy ? 0.7 : 1,
                }}
              >
                {busy && <Spinner size={11} color="var(--tp-on-primary)" thickness={2} />}
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
