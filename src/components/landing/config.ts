/**
 * The landing page's hero video, read in one place.
 *
 * TWO SOURCES, one switch — `NEXT_PUBLIC_LANDING_VIDEO_BASE_URL`. Both are
 * the same 6.17 s seamless loop of Penny, ALREADY slowed to 0.6x at a true
 * 30 fps, muted, no audio track, metadata stripped; frame 0 is the poster and
 * the last frame leads back into it. Both play at 1x.
 *
 * - UNSET (the default): the copy committed in public/landing/ (Sam,
 *   2026-09-26), hero-1920.mp4 (1080p) and hero-1280.mp4 (720p), served by the
 *   normal CDN.
 * - SET: the 4K copy on the Vercel Blob store `feral-travels-media`, e.g.
 *   https://x4hcb3okuf17fqdz.public.blob.vercel-storage.com/hero/v1/ (with
 *   or without the trailing slash). Built by a script outside git; to change
 *   it, upload hero/v2/ and point the variable there.
 *
 * THE RATE FOLLOWS THE SOURCE. It is chosen with the sources in
 * `landingVideo()` and never set on its own, so a future source at normal speed
 * cannot be wired in without deciding how fast it plays. Slowing a pre-slowed
 * file again would play Penny at 0.36x.
 *
 * WHY BLOB IS OPT-IN: the Vercel Hobby plan caps Blob transfer at 10 GB a
 * month (about 560 desktop plays), and past that Blob is locked for 30 days.
 * The committed clip is served by the normal CDN with no such cap.
 *
 * A visitor with Reduce Motion gets the poster alone and downloads neither.
 */

export type LandingVideoSource = { src: string; type: string; media?: string };
export type LandingVideo = { sources: readonly LandingVideoSource[]; rate: number };

/** Phones and small screens take the first source; everything else falls through. */
const SMALL_SCREEN = '(max-width: 1080px)';

const COMMITTED: LandingVideo = {
  sources: [
    { media: SMALL_SCREEN, src: '/landing/hero-1280.mp4', type: 'video/mp4' },
    { src: '/landing/hero-1920.mp4', type: 'video/mp4' },
  ],
  rate: 1,
};

/**
 * Pure, so the choice is unit-tested (config.test.ts). The codec strings on the
 * Blob sources let a browser that cannot decode HEVC skip it without
 * downloading any of it and fall to the 2160p h264.
 */
export function landingVideo(baseUrl: string | undefined): LandingVideo {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base) return COMMITTED;
  return {
    sources: [
      { media: SMALL_SCREEN, src: `${base}/hero-1080p-h264.mp4`, type: 'video/mp4; codecs="avc1.640029"' },
      { src: `${base}/hero-2160p-hevc.mp4`, type: 'video/mp4; codecs="hvc1.2.4.L150.B0"' },
      { src: `${base}/hero-2160p-h264.mp4`, type: 'video/mp4; codecs="avc1.640033"' },
    ],
    rate: 1,
  };
}

/**
 * The sources this screen should offer, in order, with `media` already decided.
 *
 * WHY NOT `<source media>`: WebKit evaluates `media` as not matching when the
 * <video> is built detached and then inserted, which is how React mounts it,
 * so an iPhone skipped the phone file and played the desktop one (5 of 6 loads
 * on the preview; 3 of 3 with Blob, 17.7 MB instead of 7.9 MB). HeroVideo
 * calls this with `matchMedia` and renders no `media` attribute at all.
 * Order is kept, so the HEVC → h264 fallback still holds.
 */
export function pickSources(
  video: LandingVideo,
  matches: (query: string) => boolean,
): { src: string; type: string }[] {
  return video.sources
    .filter((s) => !s.media || matches(s.media))
    .map(({ src, type }) => ({ src, type }));
}

// NEXT_PUBLIC_ values are inlined at build time, so the variable is referenced
// by its literal name — `process.env[name]` would read undefined in the browser.
export const LANDING_VIDEO = landingVideo(process.env.NEXT_PUBLIC_LANDING_VIDEO_BASE_URL);

/**
 * Frame 0 of the loop (Penny far down the track), so the poster
 * hands over to the video without a jump. The whole hero under Reduce Motion.
 */
export const LANDING_POSTER = '/landing/hero-poster.jpg';
export const LANDING_POSTER_WIDTH = 1920;
export const LANDING_POSTER_HEIGHT = 1080;
