'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Spinner from './Spinner';

interface PullToRefreshProps {
  /**
   * Called when the user pulls past the threshold and releases.
   * Should return a promise that resolves when the refresh is done so
   * the spinner stays visible for the right duration.
   */
  onRefresh: () => Promise<void> | void;
  children: React.ReactNode;
  /** Distance in px the user must pull before releasing triggers refresh. Default 70. */
  threshold?: number;
  /**
   * If true, the component is disabled (e.g. on desktop, or when the
   * underlying scroll container isn't at the top). Touch events pass
   * through untouched.
   */
  disabled?: boolean;
  /**
   * Element that actually scrolls. When omitted we listen on window
   * (standard page). For layouts where the window is pinned and a
   * child div scrolls (e.g. mobile TripWorkspace tabs), point this at
   * that div's ref — we'll check `el.scrollTop === 0` instead of
   * `window.scrollY === 0` to decide when to engage.
   */
  scrollContainer?: HTMLElement | null;
}

/**
 * Mobile-only pull-to-refresh wrapper. Only activates on pure vertical
 * downward touches that START when window.scrollY === 0 — so horizontal
 * swipes, mid-scroll gestures, and pulls from inside nested scrollers
 * (chat, maps) don't hijack the page.
 *
 * We don't hook into the browser's overscroll behavior — that's
 * platform-specific (iOS rubber-bands, Android has a built-in refresher
 * on some sites) and unreliable. Manual touch handling gives us a
 * consistent feel across both.
 *
 * Desktop mouse wheel and trackpad "pull" are not handled — those don't
 * have a natural release event and users don't expect the gesture.
 */
export default function PullToRefresh({
  onRefresh,
  children,
  threshold = 70,
  disabled = false,
  scrollContainer,
}: PullToRefreshProps) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startYRef = useRef<number | null>(null);
  const activeRef = useRef(false);

  const reset = useCallback(() => {
    startYRef.current = null;
    activeRef.current = false;
    setPull(0);
  }, []);

  useEffect(() => {
    if (disabled) return;
    const target: HTMLElement | Window = scrollContainer ?? window;
    const atTop = () => {
      if (scrollContainer) return scrollContainer.scrollTop <= 0;
      return window.scrollY <= 0;
    };

    function onTouchStart(e: Event) {
      const te = e as TouchEvent;
      if (!atTop()) return;
      if (te.touches.length !== 1) return;
      startYRef.current = te.touches[0].clientY;
      activeRef.current = false;
    }

    function onTouchMove(e: Event) {
      const te = e as TouchEvent;
      if (startYRef.current == null) return;
      if (refreshing) return;
      const dy = te.touches[0].clientY - startYRef.current;
      if (dy <= 0) {
        // User swiped up — abandon.
        reset();
        return;
      }

      // Once the pull is meaningfully downward AND we're still at the top,
      // engage: preventDefault so the viewport doesn't rubber-band AND
      // the browser doesn't try to refresh on its own.
      if (!atTop()) {
        reset();
        return;
      }
      if (dy > 8) activeRef.current = true;
      if (activeRef.current) {
        // Passive:false is required for preventDefault to stick on iOS.
        if (te.cancelable) te.preventDefault();
        // Rubber-band the pull — exponential damping so >threshold feels
        // hard to keep pulling. sqrt gives a nice natural curve.
        const damped = Math.min(dy, threshold + Math.sqrt(Math.max(0, dy - threshold)) * 6);
        setPull(damped);
      }
    }

    async function onTouchEnd() {
      if (!activeRef.current) {
        reset();
        return;
      }
      const crossed = pull >= threshold;
      if (!crossed) {
        reset();
        return;
      }
      setRefreshing(true);
      setPull(threshold);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
        reset();
      }
    }

    // `passive: false` on the move handler is mandatory or
    // preventDefault() becomes a no-op on iOS. Leave start/end passive
    // for better scrolling performance.
    target.addEventListener('touchstart', onTouchStart, { passive: true });
    target.addEventListener('touchmove', onTouchMove, { passive: false });
    target.addEventListener('touchend', onTouchEnd, { passive: true });
    target.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      target.removeEventListener('touchstart', onTouchStart);
      target.removeEventListener('touchmove', onTouchMove);
      target.removeEventListener('touchend', onTouchEnd);
      target.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [disabled, onRefresh, pull, refreshing, reset, scrollContainer, threshold]);

  const visible = pull > 0 || refreshing;
  const progress = Math.min(1, pull / threshold);

  return (
    <>
      {visible && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 40,
            transform: `translateY(${Math.max(0, pull - 24)}px)`,
            transition: refreshing ? 'transform 180ms ease' : 'none',
          }}
        >
          <div
            style={{
              marginTop: 12,
              padding: '6px 14px',
              borderRadius: 999,
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              backdropFilter: 'blur(8px)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11,
              color: 'var(--tp-muted)',
              
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            {refreshing ? (
              <>
                <Spinner size={12} thickness={2} color="var(--tp-primary)" />
                Refreshing
              </>
            ) : progress >= 1 ? (
              <>↻ Release to refresh</>
            ) : (
              <>↓ Pull to refresh</>
            )}
          </div>
        </div>
      )}
      {children}
    </>
  );
}
