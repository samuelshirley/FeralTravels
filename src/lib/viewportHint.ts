/**
 * The viewport hint: which layout the server should render FIRST.
 *
 * `useMediaQuery` cannot read `matchMedia` during render — that produced
 * hydration errors #418/#425/#423 on every mobile load — so every client's
 * first render used to be `desktop`, and `TripWorkspace` then swapped its
 * whole tree for the mobile one after hydration. Two trees mounting, on every
 * reload, visibly (2026-09-04).
 *
 * The fix is a HINT the server can act on: a cookie, written by a tiny
 * blocking script in the root layout from `window.innerWidth`, read back by
 * the pages that render viewport-dependent trees and passed into
 * `useViewport` as the initial value. Server markup and the client's first
 * render then agree on the same tree, so there is nothing to swap — and no
 * mismatch, because the initial value comes from the request, not from the
 * window. The effect still syncs to the real `matchMedia` afterwards, so a
 * stale cookie (window resized since) costs one swap, once.
 *
 * The very first visit of a fresh browser has no cookie and still flashes
 * once; every reload after it does not, which is the case that was reported.
 */
import { BREAKPOINTS, type Viewport } from '@/lib/breakpoints';
export { viewportFromWidth } from '@/lib/breakpoints';

export const VIEWPORT_COOKIE = 'tp-viewport';

/** A year: the cookie is rewritten on every load anyway. */
export const VIEWPORT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Narrow whatever the cookie holds to a Viewport, or null when it is unusable. */
export function parseViewportHint(raw: string | null | undefined): Viewport | null {
  return raw === 'mobile' || raw === 'tablet' || raw === 'desktop' ? raw : null;
}

/**
 * The inline script the root layout runs before anything paints. Plain ES5 in
 * a string, because it is emitted verbatim into the HTML. It writes the cookie
 * from the live window width and keeps it current across resizes.
 */
export const VIEWPORT_HINT_SCRIPT = `(function(){try{var t=${BREAKPOINTS.tablet},d=${BREAKPOINTS.desktop};function v(){var w=window.innerWidth;return w<t?'mobile':w<d?'tablet':'desktop'}function w(){document.cookie='${VIEWPORT_COOKIE}='+v()+'; path=/; max-age=${VIEWPORT_COOKIE_MAX_AGE}; samesite=lax'}w();var p;window.addEventListener('resize',function(){clearTimeout(p);p=setTimeout(w,150)})}catch(e){}})();`;
