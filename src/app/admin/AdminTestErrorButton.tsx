'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * Tiny admin-only button that deliberately triggers each tier of the global
 * error UI so you can smoke-test toast / modal / network surfaces on prod
 * without waiting for a real failure.
 */
export default function AdminTestErrorButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function trigger(kind: '4xx' | '5xx' | 'network') {
    setBusy(true);
    try {
      if (kind === 'network') {
        // Hitting a non-existent host triggers TypeError fail path in apiFetch.
        await apiFetch('https://trip-planner-does-not-exist.invalid/nope');
      } else {
        await apiFetch(`/api/admin/test-error?kind=${kind}`);
      }
    } catch {
      // Swallow — the global notifier already surfaced it.
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        style={{
          background: 'var(--tp-danger-muted)',
          border: '1px solid rgba(198, 93, 74, 0.35)',
          color: 'var(--tp-danger)',
          padding: '6px 12px',
          borderRadius: 4,
          fontSize: 11,
          cursor: busy ? 'wait' : 'pointer',
          fontWeight: 600,
          
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {busy ? 'Sending…' : 'Test error UI'}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            background: 'var(--tp-surface)',
            border: '1px solid var(--tp-border)',
            borderRadius: 6,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            zIndex: 100,
            minWidth: 180,
            boxShadow: 'var(--tp-shadow-md)',
          }}
        >
          <MenuItem onClick={() => trigger('4xx')}>
            Throw 400 (toast)
          </MenuItem>
          <MenuItem onClick={() => trigger('5xx')}>
            Throw 500 (silly modal)
          </MenuItem>
          <MenuItem onClick={() => trigger('network')}>
            Network fail (silly modal)
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        color: 'var(--tp-text)',
        padding: '6px 10px',
        borderRadius: 4,
        fontSize: 12,
        cursor: 'pointer',
        textAlign: 'left',
        
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--tp-primary-muted)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
