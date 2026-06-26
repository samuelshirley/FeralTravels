'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Friendly "I'm doing some planning" loader shown during a long Penny planning
 * turn (the post-onboarding full-trip build, and chained auto-continue turns).
 * It replaces the bare 3-dot typing indicator after a short delay so the wait
 * reads as intentional rather than stalled.
 *
 * Composition (per design 05-loading-ux-video): a short copy line, a small
 * looping video of the dogs playing fetch, and the 3-dots STILL present below —
 * so it reads as "thinking, with a video," not "a video instead of progress."
 *
 * Asset is served from /public. Until the real clip lands this degrades
 * gracefully: a missing/blocked video falls back to the poster, and a missing
 * poster falls back to just copy + dots. Nothing here ever blocks input.
 */

const VIDEO_SRC = '/penny-planning.mp4';
const POSTER_SRC = '/penny-planning.jpg';
const COPY = 'Give me a sec — mapping your route and finding fuel…';

export default function PennyPlanningLoader() {
  // Falls to false the moment the <video>/<img> errors (e.g. asset not shipped
  // yet, or codec unsupported) so we never render a broken media box.
  const [mediaOk, setMediaOk] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Kick off playback. If autoplay is blocked the promise rejects and the
  // poster simply stays on screen — no error surfaced to the user.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || reducedMotion) return;
    const p = v.play?.();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        /* autoplay blocked — poster frame remains visible */
      });
    }
  }, [reducedMotion]);

  return (
    <div className="penny-planning-loader" aria-label="Penny is planning your trip">
      <div className="penny-planning-copy">{COPY}</div>

      {mediaOk &&
        (reducedMotion ? (
          // Reduced motion: hold a still frame instead of an autoplaying clip.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="penny-planning-media"
            src={POSTER_SRC}
            alt=""
            onError={() => setMediaOk(false)}
          />
        ) : (
          <video
            ref={videoRef}
            className="penny-planning-media"
            src={VIDEO_SRC}
            poster={POSTER_SRC}
            muted
            playsInline
            autoPlay
            loop
            preload="none"
            onError={() => setMediaOk(false)}
          />
        ))}

      {/* The 3-dots stay so this still reads as "thinking". */}
      <div className="typing-indicator-bubble" aria-hidden="true">
        <span className="typing-indicator-dot" />
        <span className="typing-indicator-dot" />
        <span className="typing-indicator-dot" />
      </div>
    </div>
  );
}
