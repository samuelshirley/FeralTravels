import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { parseViewportHint, VIEWPORT_COOKIE } from '@/lib/viewportHint';
import { ViewportHintProvider } from '@/components/ViewportHintContext';

/**
 * Server half of the viewport hint: read the cookie the root layout's inline
 * script wrote on the previous load, and hand it to the client tree as the
 * initial viewport.
 *
 * Reading `cookies()` makes a route dynamic, so this wraps the pages that
 * already are (they need a session) and render viewport-dependent trees:
 * the trip workspace, the trips list and Settings. It is deliberately NOT in
 * the root layout, which would drag the anonymous legal pages into dynamic
 * rendering for a hint they do not use.
 */
export default function ViewportHintFromCookie({ children }: { children: ReactNode }) {
  const hint = parseViewportHint(cookies().get(VIEWPORT_COOKIE)?.value);
  return <ViewportHintProvider hint={hint}>{children}</ViewportHintProvider>;
}
