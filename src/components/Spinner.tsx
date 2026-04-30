'use client';

interface SpinnerProps {
  size?: number;
  color?: string;
  thickness?: number;
}

export default function Spinner({ size = 14, color = 'currentColor', thickness = 2 }: SpinnerProps) {
  return (
    <span
      aria-label="Loading"
      role="status"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `${thickness}px solid var(--tp-border)`,
        borderTopColor: color,
        borderRadius: '50%',
        animation: 'tp-spin 0.8s linear infinite',
        verticalAlign: 'middle',
      }}
    >
      <style jsx>{`
        @keyframes tp-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </span>
  );
}

interface OverlayProps {
  message?: string;
}

export function LoadingOverlay({ message = 'Loading…' }: OverlayProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--tp-overlay)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        color: 'var(--tp-text)',
      }}
    >
      <Spinner size={32} color="var(--tp-success)" thickness={3} />
      <div
        style={{
          fontSize: 13,
          letterSpacing: '0.1em',
          color: 'var(--tp-muted)',
          textTransform: 'uppercase',
        }}
      >
        {message}
      </div>
    </div>
  );
}
