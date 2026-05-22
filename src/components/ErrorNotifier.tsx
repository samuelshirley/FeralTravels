'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  registerGlobalErrorReporter,
} from '@/lib/api';
import { pickSillyError, type SillyError } from '@/lib/sillyErrors';

/**
 * ErrorNotifier — single global mount that owns the toast (4xx) and the
 * full-screen silly-error modal (5xx / network). Registers itself as the
 * global reporter on mount so every apiFetch call without
 * `skipGlobalErrorReport` ends up here.
 *
 * Rendered once from src/app/layout.tsx. Do not mount it a second time —
 * the reporter registration would clobber each other.
 */

interface ToastState {
  id: number;
  status: number;
  message: string;
  path: string;
  errorId?: string;
}

interface ModalState {
  silly: SillyError;
  detail: string;
  path: string;
  status: number | null;
  errorId?: string;
}

// Status codes we route to toast vs modal.
function classify(status: number | null): 'toast' | 'modal' {
  if (status == null) return 'modal'; // network / offline
  if (status >= 500) return 'modal';
  if (status === 401 || status === 403) return 'toast'; // treat auth failures as toast
  if (status >= 400) return 'toast';
  return 'toast';
}

export default function ErrorNotifier() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  // `boomGifOk` starts as null (unknown); probed once, then pinned true/false.
  // Saves loading the gif every time the modal opens if it doesn't exist.
  const [boomGifOk, setBoomGifOk] = useState<boolean | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const report = useCallback(
    (err: unknown, ctx: { path: string; status: number | null; errorId?: string }) => {
      const status = ctx.status;
      const surface = classify(status);
      const errorId = ctx.errorId ?? (err instanceof ApiError ? err.errorId ?? undefined : undefined);
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Unexpected error';
      if (surface === 'toast') {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({
          id: Date.now(),
          status: status ?? 0,
          message,
          path: ctx.path,
          errorId,
        });
        toastTimer.current = setTimeout(() => setToast(null), 5000);
      } else {
        setModal({
          silly: pickSillyError(),
          detail: message,
          path: ctx.path,
          status,
          errorId,
        });
      }
    },
    []
  );

  useEffect(() => {
    registerGlobalErrorReporter(report);
    return () => registerGlobalErrorReporter(null);
  }, [report]);

  // Probe for /errors/boom.gif once on mount. If it exists, use it; otherwise
  // fall back to the emoji. No network noise on repeated errors.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setBoomGifOk(true);
    };
    img.onerror = () => {
      if (!cancelled) setBoomGifOk(false);
    };
    img.src = '/errors/boom.gif';
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <style>{`
        @keyframes tp-error-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes tp-dot-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.15); }
        }
      `}</style>
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
      {modal && (
        <SillyModal
          modal={modal}
          boomGifOk={boomGifOk}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 'calc(16px + env(safe-area-inset-top, 0px))',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        minWidth: 240,
        maxWidth: 'calc(100vw - 32px)',
        background: 'rgba(198, 93, 74, 0.95)',
        color: '#FFFFFF',
        border: '1px solid rgba(0,0,0,0.2)',
        borderRadius: 8,
        padding: '10px 14px',
        fontSize: 13,
        fontWeight: 500,
        boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span
        style={{

          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          background: 'rgba(0,0,0,0.2)',
          padding: '2px 6px',
          borderRadius: 3,
          flexShrink: 0,
        }}
      >
        {toast.status || 'ERR'}
      </span>
      <span style={{ flex: 1, wordBreak: 'break-word' }}>{toast.message}</span>
      {toast.errorId && (
        <ErrorIdBadge errorId={toast.errorId} />
      )}
      <button
        onClick={onClose}
        aria-label="Dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          fontSize: 18,
          lineHeight: 1,
          padding: '0 4px',
          cursor: 'pointer',
          fontWeight: 700,
        }}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full-screen silly modal (5xx / network)
// ---------------------------------------------------------------------------

const RETRY_KEY = 'tp-error-retry';

function SillyModal({
  modal,
  boomGifOk,
  onClose,
}: {
  modal: ModalState;
  boomGifOk: boolean | null;
  onClose: () => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const [reloading, setReloading] = useState(false);

  // Detect if we just reloaded and the error came back.
  const isRetry = (() => {
    try {
      const ts = sessionStorage.getItem(RETRY_KEY);
      if (ts && Date.now() - Number(ts) < 15_000) return true;
    } catch { /* SSR or blocked storage */ }
    return false;
  })();

  const handleReload = () => {
    setReloading(true);
    try {
      sessionStorage.setItem(RETRY_KEY, String(Date.now()));
    } catch { /* ignore */ }
    // Small delay so spinner is visible and server has a moment to recover.
    setTimeout(() => window.location.reload(), 1500);
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="silly-error-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--tp-overlay)',
        zIndex: 10001,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 460,
          background: 'var(--tp-surface)',
          border: '1px solid var(--tp-border)',
          borderRadius: 12,
          padding: '28px 24px 20px',
          textAlign: 'center',
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            width: 120,
            height: 120,
            margin: '0 auto 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--tp-danger-muted)',
            borderRadius: '50%',
            overflow: 'hidden',
          }}
        >
          {boomGifOk ? (
            <img
              src="/errors/boom.gif"
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <span
              style={{
                fontSize: 64,
                animation: 'tp-dot-pulse 1.2s infinite ease-in-out',
                display: 'inline-block',
              }}
            >
              {modal.silly.emoji}
            </span>
          )}
        </div>
        <h2
          id="silly-error-title"
          style={{
            fontSize: 18,
            fontWeight: 700,
            margin: '0 0 8px',
            color: 'var(--tp-text)',
            lineHeight: 1.3,
          }}
        >
          {isRetry ? 'Still chasing that squirrel.' : modal.silly.headline}
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--tp-muted)',
            margin: '0 0 20px',
            lineHeight: 1.5,
          }}
        >
          {isRetry
            ? "Something’s still off. Try again in a few minutes — we’re on it."
            : modal.silly.body}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={handleReload}
            disabled={reloading}
            style={{
              background: 'var(--tp-primary)',
              color: 'var(--tp-on-primary)',
              border: 'none',
              padding: '10px 20px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 700,
              cursor: reloading ? 'default' : 'pointer',
              opacity: reloading ? 0.8 : 1,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              transition: 'opacity 0.2s',
            }}
          >
            {reloading && (
              <span
                style={{
                  width: 14,
                  height: 14,
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTopColor: 'var(--tp-on-primary)',
                  borderRadius: '50%',
                  display: 'inline-block',
                  animation: 'tp-error-spin 0.7s linear infinite',
                }}
              />
            )}
            {reloading ? 'Reloading…' : 'Reload'}
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              color: 'var(--tp-muted)',
              border: '1px solid var(--tp-border)',
              padding: '10px 20px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
        <button
          onClick={() => setShowDetail((s) => !s)}
          style={{
            marginTop: 14,
            background: 'transparent',
            border: 'none',
            color: 'var(--tp-muted)',
            fontSize: 11,
            
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {showDetail ? 'Hide' : 'Show'} technical details
        </button>
        {modal.errorId && (
          <div style={{ marginTop: 14 }}>
            <ErrorIdBadge errorId={modal.errorId} variant="modal" />
          </div>
        )}
        {showDetail && (
          <div
            style={{
              marginTop: 10,
              padding: '10px 12px',
              background: 'var(--tp-surface-muted)',
              border: '1px solid var(--tp-border)',
              borderRadius: 6,
              textAlign: 'left',
              fontSize: 11,
              color: 'var(--tp-muted)',

              wordBreak: 'break-word',
            }}
          >
            {modal.errorId && (
              <div style={{ marginBottom: 4 }}>ID: {modal.errorId}</div>
            )}
            <div>{modal.status != null ? `HTTP ${modal.status}` : 'Network error'}</div>
            <div style={{ color: 'var(--tp-subtle)', marginTop: 4 }}>{modal.path}</div>
            <div style={{ color: 'var(--tp-subtle)', marginTop: 4 }}>{modal.detail}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copyable error ID badge — used in both toast and modal
// ---------------------------------------------------------------------------

function ErrorIdBadge({
  errorId,
  variant = 'toast',
}: {
  errorId: string;
  variant?: 'toast' | 'modal';
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(errorId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const isModal = variant === 'modal';

  return (
    <button
      onClick={handleCopy}
      title={`Copy error ID: ${errorId}`}
      style={{
        background: isModal ? 'var(--tp-surface-muted)' : 'rgba(0,0,0,0.25)',
        border: isModal ? '1px solid var(--tp-border)' : '1px solid rgba(255,255,255,0.15)',
        color: isModal ? 'var(--tp-muted)' : 'rgba(255,255,255,0.85)',
        padding: '3px 8px',
        borderRadius: 4,
        fontSize: 10,
        fontFamily: 'monospace',
        cursor: 'pointer',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        letterSpacing: '0.03em',
        transition: 'background 0.15s',
      }}
    >
      {copied ? 'Copied!' : errorId}
    </button>
  );
}
