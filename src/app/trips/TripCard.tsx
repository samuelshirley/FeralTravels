'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';

interface Props {
  id: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: string;
}

// How long a user has to press-and-hold on a trip card before the delete
// affordance appears on touch devices. 500ms lines up with the iOS/Android
// long-press convention and avoids triggering on normal taps.
const LONG_PRESS_MS = 500;

// How far (in CSS px) the finger is allowed to drift before we abort the
// long-press. Prevents the reveal from firing on a scroll.
const LONG_PRESS_MOVE_TOLERANCE = 10;

export default function TripCard({ id, name, startDate, endDate, status }: Props) {
  const router = useRouter();
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false); // revealed by long-press on touch
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const revealed = hover || pressed || confirming || busy;

  function clearLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    pressOrigin.current = null;
  }

  // Dismiss the revealed state when the user taps outside the card.
  useEffect(() => {
    if (!pressed && !confirming) return;
    function onDocPointerDown(e: PointerEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setPressed(false);
        setConfirming(false);
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [pressed, confirming]);

  function handlePointerDown(e: React.PointerEvent) {
    // Desktop mouse: we already show the X on hover, skip long-press logic.
    if (e.pointerType === 'mouse') return;
    pressOrigin.current = { x: e.clientX, y: e.clientY };
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      suppressClickRef.current = true;
      setPressed(true);
      // Light haptic feedback on supported devices; no-op elsewhere.
      if ('vibrate' in navigator) {
        try {
          navigator.vibrate?.(12);
        } catch {
          /* ignore */
        }
      }
    }, LONG_PRESS_MS);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!longPressTimer.current || !pressOrigin.current) return;
    const dx = e.clientX - pressOrigin.current.x;
    const dy = e.clientY - pressOrigin.current.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) clearLongPress();
  }

  function handlePointerEnd() {
    clearLongPress();
  }

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/api/trips/${id}`, { method: 'DELETE' });
      router.refresh();
    } catch (ex: any) {
      setErr(ex?.message || 'Failed to delete');
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        if (!pressed) setConfirming(false);
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
      // Prevent the iOS/Android browser context menu (image/link "save",
      // "copy link", etc.) from fighting our long-press UX.
      onContextMenu={(e) => {
        if (pressed) e.preventDefault();
      }}
      style={{
        position: 'relative',
        // Stops long-press on iOS Safari from selecting the card text.
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
    >
      <Link
        href={`/trips/${id}`}
        onClick={(e) => {
          if (suppressClickRef.current) {
            e.preventDefault();
            e.stopPropagation();
            suppressClickRef.current = false;
          }
        }}
        style={{
          display: 'block',
          padding: 16,
          background: pressed ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)',
          border: pressed
            ? '1px solid rgba(232,146,124,0.35)'
            : '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          color: '#fff',
          textDecoration: 'none',
          transition: 'background 120ms, border-color 120ms',
          pointerEvents: busy ? 'none' : 'auto',
          opacity: busy ? 0.5 : 1,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, paddingRight: 28 }}>{name}</div>
        <div
          style={{
            fontSize: 12,
            color: 'rgba(255,255,255,0.45)',
            fontFamily: "'JetBrains Mono', monospace",
            marginTop: 4,
          }}
        >
          {[startDate, endDate].filter(Boolean).join(' → ') || 'No dates set'}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            marginTop: 8,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          status: {status}
        </div>
      </Link>

      {revealed && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy}
          aria-label={confirming ? 'Confirm delete trip' : 'Delete trip'}
          title={confirming ? 'Click again to confirm' : 'Delete trip'}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: confirming ? 'auto' : 28,
            height: 28,
            minWidth: 28,
            padding: confirming ? '0 10px' : 0,
            borderRadius: 14,
            background: confirming ? '#E8927C' : 'rgba(0,0,0,0.6)',
            border: confirming
              ? '1px solid #E8927C'
              : '1px solid rgba(255,255,255,0.2)',
            color: confirming ? '#0D0D0D' : 'rgba(255,255,255,0.9)',
            fontSize: confirming ? 11 : 16,
            fontWeight: confirming ? 700 : 400,
            lineHeight: 1,
            cursor: busy ? 'default' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            transition: 'all 120ms',
            backdropFilter: 'blur(6px)',
            boxShadow: pressed ? '0 4px 12px rgba(0,0,0,0.4)' : 'none',
          }}
        >
          {busy ? (
            <Spinner size={11} color="#fff" thickness={2} />
          ) : confirming ? (
            'Delete?'
          ) : (
            '×'
          )}
        </button>
      )}

      {err && (
        <div
          style={{
            position: 'absolute',
            bottom: -18,
            left: 0,
            fontSize: 11,
            color: '#E8927C',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}
