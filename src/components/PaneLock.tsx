'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

/**
 * A pane that is still on screen and no longer works.
 *
 * The mechanism only — it knows nothing about billing. It takes a pane's
 * content, keeps it VISIBLE, and takes it out of the application: no clicks, no
 * scroll, no tab stop, no screen-reader tour of a day the user cannot open.
 * What the scrim says on top is the caller's business (see
 * `TripPaywallLock.tsx` for the paywall's version).
 *
 * Visible is the whole point. "Your trip is paused" and "your trip is gone" are
 * different sentences and only one of them is true, so the list stays legible
 * underneath — the same argument `EntitlementOverlay` makes for the trips page.
 *
 * TWO things do the blocking, and both are needed:
 *
 *  - `inert` on the content wrapper. This is the only thing that removes a
 *    whole subtree from the tab order and the accessibility tree in one go —
 *    `pointer-events: none` leaves every button in that pane still reachable
 *    with Tab and still announced, which for a screen reader user is the same
 *    broken pane with none of the visual warning. Set imperatively rather than
 *    as a JSX prop because React 18's JSX types have no `inert` attribute; React
 *    only manages props it set itself, so the cleanup below is what removes it.
 *  - The scrim element itself, which is a sibling and therefore NOT inert. It
 *    covers the pane edge to edge, so a stray wheel or touch lands on it
 *    instead of the map underneath, and it is where the explanation lives.
 *
 * `pointer-events: none` is still applied to the content as the fallback for a
 * browser too old for `inert` (pre-2023 Safari/Firefox). It restores the mouse
 * half of the block; the tab-order half genuinely needs `inert` and there is no
 * cheap polyfill for it that survives a lazily-rendered subtree.
 */
export default function PaneLock({
  locked,
  notice = null,
  style,
  children,
}: {
  locked: boolean;
  /**
   * Drawn centred on the scrim. Null gives a bare wash — which is what the map
   * gets on the layouts where the itinerary is beside it and already carries
   * the message. Saying it twice on one screen reads as a bug.
   */
  notice?: ReactNode;
  /**
   * Merged over the root. The mobile layout positions its panes absolutely, and
   * the pane's own positioning has to live on this element rather than on a
   * child — the scrim is positioned against the root, so the root has to be the
   * box that is exactly the size of the pane.
   */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (!locked) {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
      return;
    }
    // Probed on the prototype rather than on `el`, which TypeScript's DOM lib
    // narrows to `never` for a property it does not know about.
    if ('inert' in HTMLElement.prototype) {
      el.setAttribute('inert', '');
    } else {
      // No `inert` in this browser. `aria-hidden` on focusable content is
      // normally a defect, but here the content is genuinely not operable and
      // announcing it would be the bigger lie.
      el.setAttribute('aria-hidden', 'true');
    }
    return () => {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    };
  }, [locked]);

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0, ...style }}>
      <div
        ref={contentRef}
        style={{
          height: '100%',
          minHeight: 0,
          ...(locked
            ? {
                pointerEvents: 'none' as const,
                // A stacking context, so the pane's own z-indexes stay inside
                // it. Without this the Google Maps controls — which sit on
                // five- and six-digit z-indexes inside the map div — paint
                // straight through the scrim, and the user is looking at a
                // dimmed map with live zoom buttons on top of the notice.
                position: 'relative' as const,
                zIndex: 0,
              }
            : null),
        }}
      >
        {children}
      </div>

      {locked && (
        <div
          data-testid="pane-lock-scrim"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            // --tp-bg at ~80%. Written out rather than composed from the token
            // because the wash has to be a translucent version of it and the
            // token is an opaque hex. Light enough to read the itinerary
            // through, heavy enough that nobody tries to click it.
            background: 'rgba(246, 242, 234, 0.8)',
            backdropFilter: 'blur(2px) saturate(0.55)',
            WebkitBackdropFilter: 'blur(2px) saturate(0.55)',
            cursor: 'default',
          }}
        >
          {notice}
        </div>
      )}
    </div>
  );
}
