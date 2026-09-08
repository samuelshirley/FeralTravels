'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The dog-fetch clip Penny "sends" while she builds the first full trip plan.
 * This renders ONLY the rounded, iMessage-style video bubble — the caption and
 * the surrounding message group are rendered by the transcript. Unlike the old
 * transient loader, this lives inside a real (persistent) Penny message, so it
 * stays in the conversation and the user can scroll back to it; it keeps
 * looping in place.
 *
 * Plays at natural 1x speed (playbackRate pinned to 1 — we never speed it up).
 * Asset URLs carry a version query so a browser that cached an earlier stub
 * clip picks up the real one; bump ASSET_VERSION when the asset changes.
 *
 * Degrades gracefully: reduced-motion holds the poster still frame, and a
 * missing/blocked asset renders nothing so the caption stands alone.
 *
 * RESUMES WHEN THE PAGE COMES BACK. A backgrounded tab (and, on iOS, a
 * backgrounded PWA) has its media paused by the browser, and `autoPlay` is a
 * load-time attribute — it does not fire again on return. The clip is the only
 * thing on screen saying Penny is still working during a 2–4 minute planning
 * turn, so a clip that comes back frozen reads as an app that has died. The
 * native port carries the same rule for the same reason
 * (mobile/components/chat/PennyPlanningVideo.tsx).
 */

const ASSET_VERSION = '2';
const VIDEO_SRC = `/penny-planning.mp4?v=${ASSET_VERSION}`;
const POSTER_SRC = `/penny-planning.jpg?v=${ASSET_VERSION}`;

export default function PennyPlanningVideo() {
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

  // Kick off looping playback at natural speed. If autoplay is blocked the
  // promise rejects and the poster simply stays on screen — no error surfaced.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || reducedMotion) return;
    v.playbackRate = 1;
    const p = v.play?.();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        /* autoplay blocked — poster frame remains visible */
      });
    }
  }, [reducedMotion]);

  // Re-issue play() when the page becomes visible again. Reduce Motion still
  // wins: it is a user setting, not a playback state.
  useEffect(() => {
    if (reducedMotion) return;
    const resume = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const v = videoRef.current;
      if (!v || !v.paused) return;
      const p = v.play?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [reducedMotion]);

  if (!mediaOk) return null;

  return (
    <div className="penny-planning-media-bubble">
      {reducedMotion ? (
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
          preload="auto"
          onError={() => setMediaOk(false)}
        />
      )}
    </div>
  );
}
