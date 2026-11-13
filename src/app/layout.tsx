import './globals.css';
import { VIEWPORT_HINT_SCRIPT } from '@/lib/viewportHint';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
// Inter's six NON-Latin subsets (Latin Extended, Cyrillic, Greek, Vietnamese),
// as `'Inter Variable'` faces with their unicode-ranges, so a browser fetches
// one only when a page draws a character in it — Łódź, Plzeň, Αθήνα.
import '@fontsource-variable/inter/wght.css';
import { Analytics } from '@vercel/analytics/next';
import ErrorNotifier from '@/components/ErrorNotifier';
import ViewportTimeReporter from '@/components/ViewportTimeReporter';

/**
 * Nocturne's face: Inter 4, SELF-HOSTED from `@fontsource-variable/inter`.
 *
 * It was `next/font/google`, which downloads the font CSS from Google during
 * EVERY build. When Google's answer was not what its parser expected the build
 * died — "An error occurred in `next/font`" — and that failed five runs between
 * 2026-09-23 and 2026-11-13, two of them PRODUCTION deploys of main (11-02,
 * 11-04), which left prod on the previous build. `fontSelfHostGuard.test.ts`
 * keeps Google out of the build.
 *
 * The same font, measured against production on 2026-11-13: Google served the
 * one variable file (Inter 4.001, `wght` 100-900, 518 glyphs) for all five
 * weights, which is this package's `latin-wght` file. One file holds every
 * weight, so the 700/800 that 140 call sites still ask for cost nothing
 * extra; the palette's rule (hierarchy is size and space, headings cap at 500,
 * 600 for the 9-11px kickers) is a style rule, not a loading one.
 *
 * Latin goes through next/font so it is still PRELOADED and hashed. The
 * fallback is NOT next/font's generated one: that would sit second in the
 * stack, and Arial has `ł`, so Latin Extended would draw in Arial before
 * `'Inter Variable'` was asked. `'Inter Fallback'` (globals.css) carries the
 * metrics next/font generated for this font, and comes last.
 */
const inter = localFont({
  src: '../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter',
  adjustFontFallback: false,
  fallback: ['Inter Variable', 'Inter Fallback'],
});

export const metadata: Metadata = {
  title: 'Feral Travels',
  description: 'Penny — your automated trip assistant',
  manifest: '/manifest.json',
  openGraph: {
    title: 'Feral Travels',
    description: 'Penny — your automated trip assistant',
    siteName: 'Feral Travels',
    type: 'website',
    images: [{ url: '/og-image.jpg', width: 1200, height: 630, alt: 'Finn the dog' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Feral Travels',
    description: 'Penny — your automated trip assistant',
    images: ['/og-image.jpg'],
  },
  // These used to be hand-written <meta>/<link> tags inside a <head> element in
  // this file. Next owns <head> — emitting your own alongside its is what broke
  // hydration app-wide. Declare them; let the framework render them.
  appleWebApp: {
    capable: true,
    title: 'Feral',
    statusBarStyle: 'default',
  },
  icons: {
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
    // iOS only honours a launch image whose media query matches the device
    // exactly, so we ship one per common iPhone/iPad class. Anything unlisted
    // falls back to a blank screen with the apple-touch-icon, which is fine.
    other: [
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-1290x2796.jpg', media: '(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-1284x2778.jpg', media: '(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-1242x2688.jpg', media: '(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-828x1792.jpg', media: '(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-1179x2556.jpg', media: '(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-1170x2532.jpg', media: '(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-1125x2436.jpg', media: '(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-750x1334.jpg', media: '(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-2048x2732.jpg', media: '(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
      { rel: 'apple-touch-startup-image', url: '/splash/apple-splash-1668x2388.jpg', media: '(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
    ],
  },
};

// The hand-written <meta name="viewport"> this used to defer to is GONE, and
// with it the duplicate: the page was serving TWO viewport metas, Next's and
// ours. `interactiveWidget` is a first-class field now, so everything the
// manual tag did is expressible here — and only Next writes to <head>.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  interactiveWidget: 'resizes-content',
  themeColor: '#161826',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {/*
          Runs before anything below it is parsed: writes the viewport cookie
          the dynamic pages read on the NEXT request so the server can render
          a phone's tree first (see lib/viewportHint.ts). Blocking on purpose
          — it is a few dozen bytes, and deferring it would leave the cookie
          one load behind the window.
        */}
        <script dangerouslySetInnerHTML={{ __html: VIEWPORT_HINT_SCRIPT }} />
        <div className="landscape-lock" aria-hidden="true">
          <div className="landscape-lock-icon">📱↻</div>
          <p className="landscape-lock-title">Please rotate your device</p>
          <p className="landscape-lock-text">
            Feral Travels works in portrait. Turn your phone upright to keep going.
          </p>
        </div>
        {children}
        <ViewportTimeReporter />
        <ErrorNotifier />
        <Analytics />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Plain SW registration. We deliberately do NOT auto-reload the
              // page when a new worker takes over — see public/sw.js for why.
              // The previous "skipWaiting + clients.claim + reload on
              // controllerchange" pattern caused an infinite reload loop on
              // mobile Chrome. New deploys now land on the user's next
              // natural navigation or refresh. If we want push-style updates
              // later, add an in-app "New version available" toast that does
              // a single deliberate reload on click.
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker
                    .register('/sw.js')
                    .catch(() => {});
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
