'use client';

interface ChatToggleButtonProps {
  open: boolean;
  onClick: () => void;
  thinking?: boolean;
  unread?: number;
  label?: string;
}

export default function ChatToggleButton({
  open,
  onClick,
  thinking = false,
  unread = 0,
  label = 'Chat',
}: ChatToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      title={open ? 'Close chat' : 'Open chat'}
      aria-pressed={open}
      style={{
        position: 'relative',
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid var(--tp-border)',
        background: open ? 'var(--tp-success-muted)' : 'var(--tp-surface-muted)',
        color: open ? 'var(--tp-success)' : 'var(--tp-muted)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span>{label}</span>
      {thinking && (
        <span
          aria-label="Penny is thinking"
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--tp-success)',
            animation: 'tp-pulse-toggle 1.2s ease-in-out infinite',
          }}
        />
      )}
      {!thinking && unread > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -6,
            right: -6,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 8,
            background: 'var(--tp-accent-warm)',
            color: 'var(--tp-on-primary)',
            fontSize: 10,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
          }}
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
      <style jsx>{`
        @keyframes tp-pulse-toggle {
          0%, 100% { opacity: 0.55; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.15); }
        }
      `}</style>
    </button>
  );
}
