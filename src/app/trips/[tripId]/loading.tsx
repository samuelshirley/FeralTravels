export default function Loading() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 16,
        background: 'var(--tp-bg)',
      }}
    >
      <span
        aria-label="Loading"
        role="status"
        style={{
          display: 'inline-block',
          width: 36,
          height: 36,
          border: '3px solid var(--tp-border)',
          borderTopColor: 'var(--tp-success)',
          borderRadius: '50%',
          animation: 'tp-spin 0.8s linear infinite',
        }}
      />
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 2,
          color: 'var(--tp-muted)',
          fontSize: 13,
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}
      >
        <span>Loading trip</span>
        <span className="loading-dot" style={{ animationDelay: '0ms' }}>.</span>
        <span className="loading-dot" style={{ animationDelay: '160ms' }}>.</span>
        <span className="loading-dot" style={{ animationDelay: '320ms' }}>.</span>
      </div>
      <style>{`@keyframes tp-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
