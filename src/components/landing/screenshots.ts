/**
 * App screenshots of the two-week Spain national-parks trip, in display order.
 *
 * Empty until the real PNGs land in public/landing/. The section renders only
 * when this has entries, so an empty list ships no placeholder frames.
 */
export type LandingScreenshot = {
  /** Path under public/, e.g. '/landing/shot-plan.png'. */
  src: string;
  alt: string;
  width: number;
  height: number;
};

export const LANDING_SCREENSHOTS: LandingScreenshot[] = [];
