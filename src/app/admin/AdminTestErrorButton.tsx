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
          background: 'rgba(232,124,124,0.1)',
          border: '1px solid rgba(232,124,124,0.3)',
          color: '#E87C7C',
          padding: '6px 12px',
          borderRadius: 4,
          fontSize: 11,
          cursor: busy ? 'wait' : 'pointer',
          fontWeight: 600,
          fontFamily: "'JetBrains Mono', monospace",
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
            background: '#0F0F0F',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 6,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            zIndex: 100,
            minWidth: 180,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
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
        color: 'rgba(255,255,255,0.85)',
        padding: '6px 10px',
        borderRadius: 4,
        fontSize: 12,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: "'JetBrains Mono', monospace",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(124,181,232,0.12)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
