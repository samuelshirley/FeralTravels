'use client';

import { useEffect } from 'react';

interface ChatDrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  widthPct?: number;
}

export default function ChatDrawer({ open, onClose, children, widthPct = 50 }: ChatDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          background: open ? 'var(--tp-overlay)' : 'transparent',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 220ms ease, background 220ms ease',
          zIndex: 900,
        }}
      />
      <aside
        role="dialog"
        aria-label="Chat with Penny"
        aria-hidden={!open}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: `${widthPct}%`,
          minWidth: 320,
          maxWidth: 520,
          background: 'var(--tp-surface)',
          borderLeft: '1px solid var(--tp-border)',
          boxShadow: open ? 'var(--tp-shadow-md)' : 'none',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)',
          zIndex: 901,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </aside>
    </>
  );
}
