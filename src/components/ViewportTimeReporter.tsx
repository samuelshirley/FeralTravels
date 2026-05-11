'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useViewport, type Viewport } from '@/lib/useMediaQuery';

const TICK_MS = 8000;
const FLUSH_MS = 60_000;

type Deltas = Record<Viewport, number>;

function emptyDeltas(): Deltas {
  return { mobile: 0, tablet: 0, desktop: 0 };
}

/**
 * Samples foreground time and POSTs integer-second deltas to
 * `/api/analytics/viewport-time`. Same viewport bands as `useViewport`.
 */
export default function ViewportTimeReporter() {
  const viewport = useViewport();
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  const deltasRef = useRef<Deltas>(emptyDeltas());
  const lastTickRef = useRef<number | null>(null);
  const skipRef = useRef(false);

  /** ADVANCE current visible slice if the tab is still foreground (periodic tick, flush while open). */
  const accrueWhileVisible = useCallback(() => {
    if (typeof performance === 'undefined') return;
    const now = performance.now();
    const last = lastTickRef.current;
    lastTickRef.current = now;
    if (last === null) return;
    if (document.visibilityState !== 'visible') return;
    const sec = (now - last) / 1000;
    if (sec <= 0) return;
    const v = viewportRef.current;
    deltasRef.current[v] += sec;
  }, []);

  /** CLOSE the visible slice when leaving foreground (visibility hidden, pagehide). */
  const closeVisibleSlice = useCallback(() => {
    if (typeof performance === 'undefined') return;
    const now = performance.now();
    const last = lastTickRef.current;
    lastTickRef.current = now;
    if (last === null) return;
    const sec = (now - last) / 1000;
    if (sec <= 0) return;
    const v = viewportRef.current;
    deltasRef.current[v] += sec;
  }, []);

  const flush = useCallback(
    async (opts?: { keepalive?: boolean; endingVisible?: boolean }) => {
      if (skipRef.current || typeof window === 'undefined') return;
      if (opts?.endingVisible) closeVisibleSlice();
      else accrueWhileVisible();

      const d = deltasRef.current;
      const mobile = Math.floor(d.mobile);
      const tablet = Math.floor(d.tablet);
      const desktop = Math.floor(d.desktop);
      if (mobile + tablet + desktop === 0) return;
      d.mobile -= mobile;
      d.tablet -= tablet;
      d.desktop -= desktop;

      try {
        const res = await fetch('/api/analytics/viewport-time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deltas: { mobile, tablet, desktop } }),
          keepalive: opts?.keepalive === true,
        });
        if (res.status === 401) skipRef.current = true;
      } catch {
        // offline — fractional remainders stay for a later flush
      }
    },
    [accrueWhileVisible, closeVisibleSlice]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    lastTickRef.current = performance.now();

    const tickId = window.setInterval(() => {
      accrueWhileVisible();
    }, TICK_MS);

    const flushId = window.setInterval(() => {
      void flush();
    }, FLUSH_MS);

    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        void flush({ keepalive: true, endingVisible: true });
      } else {
        lastTickRef.current = performance.now();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    const onPageHide = () => {
      void flush({ keepalive: true, endingVisible: true });
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      clearInterval(tickId);
      clearInterval(flushId);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
      void flush({ endingVisible: true });
    };
  }, [accrueWhileVisible, flush]);

  return null;
}
