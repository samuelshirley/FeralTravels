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
}

interface ModalState {
  silly: SillyError;
  detail: string;
  path: string;
  status: number | null;
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
    (err: unknown, ctx: { path: string; status: number | null }) => {
      const status = ctx.status;
      const surface = classify(status);
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
        });
        toastTimer.current = setTimeout(() => setToast(null), 5000);
      } else {
        setModal({
          silly: pickSillyError(),
          detail: message,
          path: ctx.path,
          status,
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
        background: 'rgba(232,124,124,0.95)',
        color: '#1a0606',
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
          fontFamily: "'JetBrains Mono', monospace",
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
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="silly-error-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
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
          background: '#0F0F0F',
          border: '1px solid rgba(255,255,255,0.12)',
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
            background: 'rgba(232,124,124,0.08)',
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
            color: '#fff',
            lineHeight: 1.3,
          }}
        >
          {modal.silly.headline}
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'rgba(255,255,255,0.7)',
            margin: '0 0 20px',
            lineHeight: 1.5,
          }}
        >
          {modal.silly.body}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#7CB5E8',
              color: '#000',
              border: 'none',
              padding: '10px 20px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Reload
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              color: 'rgba(255,255,255,0.7)',
              border: '1px solid rgba(255,255,255,0.2)',
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
            color: 'rgba(255,255,255,0.4)',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {showDetail ? 'Hide' : 'Show'} technical details
        </button>
        {showDetail && (
          <div
            style={{
              marginTop: 10,
              padding: '10px 12px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
              textAlign: 'left',
              fontSize: 11,
              color: 'rgba(255,255,255,0.7)',
              fontFamily: "'JetBrains Mono', monospace",
              wordBreak: 'break-word',
            }}
          >
            <div>{modal.status != null ? `HTTP ${modal.status}` : 'Network error'}</div>
            <div style={{ color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>{modal.path}</div>
            <div style={{ color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>{modal.detail}</div>
          </div>
        )}
      </div>
    </div>
  );
}
