'use client';

import { useEffect, useRef, useState } from 'react';
import { LANDING_POSTER, LANDING_VIDEO, pickSources } from './config';

/**
 * The looping clip behind the hero, layered over the server-rendered poster.
 *
 * Mounted only after hydration, and only without Reduce Motion, so the video
 * never competes with first paint: the poster <img> is the LCP element and the
 * clip is laid over it, carrying the same poster until its first frame. A
 * reduced-motion visitor never downloads it at all — hiding it with CSS alone
 * would still fetch the file.
 *
 * RESUMES ON FOREGROUND, the lesson PennyPlanningVideo learned (architecture.md):
 * browsers pause a backgrounded video, and `autoPlay` is a load-time attribute
 * that never fires twice. Without this, switching tabs and back leaves a frozen
 * frame behind the headline.
 *
 * THE SOURCES ARE PICKED HERE, not by `<source media>`: WebKit reads `media` as
 * not matching on a video React mounts, so iPhones played the desktop file
 * (see `pickSources` in config.ts).
 */
export default function HeroVideo({ className }: { className: string }) {
  // null until mounted, and for good under Reduce Motion: no video at all.
  const [sources, setSources] = useState<{ src: string; type: string }[] | null>(null);
  const motionOk = sources !== null;
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setSources(pickSources(LANDING_VIDEO, (q) => window.matchMedia(q).matches));
  }, []);

  // Reduce Motion still wins: with it on there is no video to resume.
  useEffect(() => {
    if (!motionOk) return;
    const resume = () => {
      if (document.visibilityState !== 'visible') return;
      const v = videoRef.current;
      if (!v || !v.paused) return;
      // Decoration: a refused play() leaves the poster, which is fine.
      v.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [motionOk]);

  if (!sources) return null;

  return (
    <video
      ref={videoRef}
      className={className}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      poster={LANDING_POSTER}
      aria-hidden="true"
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        // Safari resets playbackRate to defaultPlaybackRate on load; set both.
        // The rate belongs to the source (config.ts); both current sources are pre-slowed, so 1.
        v.defaultPlaybackRate = LANDING_VIDEO.rate;
        v.playbackRate = LANDING_VIDEO.rate;
      }}
    >
      {/* In order: the browser plays the first source it can. */}
      {sources.map((s) => (
        <source key={s.src} src={s.src} type={s.type} />
      ))}
    </video>
  );
}
