'use client';

import { useState } from 'react';

interface Props {
  pretty: string;
}

/**
 * Tiny "Show edit JSON" expander used inside an admin chat message bubble.
 * Kept as its own client island so the parent page can stay a server component
 * (and the JSON is just a static prop — no fetch on click).
 */
export default function ChangesToggle({ pretty }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'transparent',
          border: '1px solid var(--tp-border)',
          color: 'var(--tp-muted)',
          fontSize: 11,
          fontWeight: 600,
          padding: '4px 10px',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        {open ? 'Hide edit payload' : 'Show edit payload'}
      </button>
      {open && (
        <pre
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: 'var(--tp-surface-muted)',
            border: '1px solid var(--tp-border)',
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--tp-text)',
            overflow: 'auto',
            maxHeight: 360,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            whiteSpace: 'pre',
          }}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
}
