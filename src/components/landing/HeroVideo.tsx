'use client';

import { useEffect, useState } from 'react';
import { LANDING_POSTER, LANDING_VIDEO_RATE } from './config';

/**
 * The looping clip behind the hero, layered over the server-rendered poster.
 *
 * Mounted only after hydration, and only without Reduce Motion, so the video
 * never competes with first paint: the poster <img> is the LCP element and the
 * clip is laid over it, carrying the same poster until its first frame. A reduced-motion visitor never
 * downloads it at all — hiding it with CSS alone would still fetch the file.
 */
export default function HeroVideo({
  src,
  smallSrc,
  type,
  className,
}: {
  src: string;
  smallSrc: string | null;
  type: string;
  className: string;
}) {
  const [motionOk, setMotionOk] = useState(false);

  useEffect(() => {
    setMotionOk(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  if (!motionOk) return null;

  return (
    <video
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
        v.defaultPlaybackRate = LANDING_VIDEO_RATE;
        v.playbackRate = LANDING_VIDEO_RATE;
      }}
    >
      {smallSrc && smallSrc !== src && <source src={smallSrc} type={type} media="(max-width: 900px)" />}
      <source src={src} type={type} />
    </video>
  );
}
