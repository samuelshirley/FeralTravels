/**
 * The landing page's hero video, read in one place.
 *
 * The clip is NOT in the repo (the repo is public and a video does not belong
 * in git); it is hosted on Vercel Blob and named by three variables:
 *
 *   NEXT_PUBLIC_LANDING_VIDEO_URL        the full-resolution mp4
 *   NEXT_PUBLIC_LANDING_VIDEO_URL_SMALL  a ≤1080p encode, served to screens
 *                                        ≤900px wide via <source media>
 *   NEXT_PUBLIC_LANDING_VIDEO_TYPE       optional MIME type for both sources;
 *                                        defaults to video/mp4
 *
 * With neither URL set the hero renders the poster image alone, which is also
 * what a visitor with Reduce Motion gets. If only one URL is set it serves
 * every width.
 *
 * NEXT_PUBLIC_ values are inlined at build time, so each is referenced by its
 * literal name — `process.env[name]` would read undefined in the browser.
 */
export const LANDING_VIDEO_URL =
  process.env.NEXT_PUBLIC_LANDING_VIDEO_URL || process.env.NEXT_PUBLIC_LANDING_VIDEO_URL_SMALL || null;

export const LANDING_VIDEO_URL_SMALL = process.env.NEXT_PUBLIC_LANDING_VIDEO_URL_SMALL || null;

export const LANDING_VIDEO_TYPE = process.env.NEXT_PUBLIC_LANDING_VIDEO_TYPE || 'video/mp4';

/** The first frame of the clip; the whole hero when there is no video. */
export const LANDING_POSTER = '/landing/hero-poster.jpg';

/** Penny runs at 0.6x: at full speed the loop reads as a jittery GIF behind the headline. */
export const LANDING_VIDEO_RATE = 0.6;
