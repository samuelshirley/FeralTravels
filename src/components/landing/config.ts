/**
 * The landing page's hero video, read in one place.
 *
 * The clip IS in the repo (Sam, 2026-09-26): public/landing/hero-1920.mp4
 * (1080p) and hero-1280.mp4 (720p), 3.9 s of Penny at normal speed, muted, no
 * audio track, metadata stripped. They are encoded at 1x on purpose;
 * LANDING_VIDEO_RATE below slows the loop to ~6.5 s in the browser.
 *
 * Three optional variables override the committed files, e.g. with a
 * higher-resolution copy on Vercel Blob:
 *
 *   NEXT_PUBLIC_LANDING_VIDEO_URL        replaces hero-1920.mp4
 *   NEXT_PUBLIC_LANDING_VIDEO_URL_SMALL  replaces hero-1280.mp4, served to
 *                                        screens ≤900px wide via <source media>
 *   NEXT_PUBLIC_LANDING_VIDEO_TYPE       MIME type for both sources; the
 *                                        committed clip is mp4, the default
 *
 * A visitor with Reduce Motion gets the poster image alone and never
 * downloads the clip.
 *
 * NEXT_PUBLIC_ values are inlined at build time, so each is referenced by its
 * literal name — `process.env[name]` would read undefined in the browser.
 */
export const LANDING_VIDEO_URL = process.env.NEXT_PUBLIC_LANDING_VIDEO_URL || '/landing/hero-1920.mp4';

export const LANDING_VIDEO_URL_SMALL = process.env.NEXT_PUBLIC_LANDING_VIDEO_URL_SMALL || '/landing/hero-1280.mp4';

export const LANDING_VIDEO_TYPE = process.env.NEXT_PUBLIC_LANDING_VIDEO_TYPE || 'video/mp4';

/**
 * A still of Penny from the clip, not its first frame (the clip fades up from
 * black); the whole hero under Reduce Motion.
 */
export const LANDING_POSTER = '/landing/hero-poster.jpg';

/** Penny runs at 0.6x: at full speed the loop reads as a jittery GIF behind the headline. */
export const LANDING_VIDEO_RATE = 0.6;
