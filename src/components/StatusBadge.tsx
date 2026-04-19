'use client';

import { STATUS_MAP, type LegStatus } from '@/types/trip';

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const s = STATUS_MAP[status as LegStatus] || STATUS_MAP.planning;
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.08em',
        padding: '3px 8px',
        borderRadius: 4,
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.text,
        whiteSpace: 'nowrap',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {s.label}
    </span>
  );
}
