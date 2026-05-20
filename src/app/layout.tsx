import type { Metadata, Viewport } from 'next';
import { Onest } from 'next/font/google';
import ErrorNotifier from '@/components/ErrorNotifier';
import ViewportTimeReporter from '@/components/ViewportTimeReporter';

const onest = Onest({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-onest',
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
};

// Note: width / initialScale / maximumScale are intentionally NOT set here
// because we render an explicit <meta name="viewport"> below that adds
// `interactive-widget=resizes-content` (iOS 17+ Safari soft-keyboard hint).
// The Next.js `viewport` export doesn't expose interactive-widget, so we
// emit the meta tag manually and limit this export to themeColor.
export const viewport: Viewport = {
  themeColor: '#4E7AB0',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={onest.variable}>
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, interactive-widget=resizes-content"
        />
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"
        />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Feral" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        {/* iOS launch (splash) screens. iOS only honours one whose media query
            exactly matches the device, so we ship one per common iPhone/iPad
            class. Anything not listed falls back to a blank screen with the
            apple-touch-icon, which is fine. Photos, JPEG q85 — total ~3.5MB
            cached on first launch. */}
        <link rel="apple-touch-startup-image" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" href="/splash/apple-splash-1290x2796.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" href="/splash/apple-splash-1284x2778.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" href="/splash/apple-splash-1242x2688.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" href="/splash/apple-splash-828x1792.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" href="/splash/apple-splash-1179x2556.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" href="/splash/apple-splash-1170x2532.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" href="/splash/apple-splash-1125x2436.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" href="/splash/apple-splash-750x1334.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" href="/splash/apple-splash-2048x2732.jpg" />
        <link rel="apple-touch-startup-image" media="(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" href="/splash/apple-splash-1668x2388.jpg" />
        <style>{`
          :root {
            --tp-font-sans: var(--font-onest), Helvetica, Arial, sans-serif;
            --tp-bg: #F6F2EA;
            --tp-surface: #FFFFFF;
            --tp-surface-muted: #FBF8F3;
            --tp-border: #E6DFD4;
            --tp-border-strong: #D4C9BA;
            --tp-text: #333333;
            --tp-muted: #5C5C5C;
            --tp-subtle: rgba(51, 51, 51, 0.45);
            --tp-primary: #4E7AB0;
            --tp-primary-hover: #3D6799;
            --tp-primary-muted: rgba(78, 122, 176, 0.14);
            --tp-on-primary: #FFFFFF;
            --tp-success: #4A8B7A;
            --tp-success-muted: rgba(74, 139, 122, 0.14);
            --tp-danger: #C65D4A;
            --tp-danger-muted: rgba(198, 93, 74, 0.12);
            --tp-accent-warm: #C97B63;
            --tp-accent-warm-muted: rgba(201, 123, 99, 0.14);
            --tp-gold: #B8956A;
            --tp-accent-violet: #6B5B9A;
            --tp-accent-violet-muted: rgba(107, 91, 154, 0.14);
            --tp-overlay: rgba(51, 51, 51, 0.4);
            --tp-shadow-sm: 0 1px 2px rgba(51, 51, 51, 0.06);
            --tp-shadow-md: 0 4px 12px rgba(51, 51, 51, 0.08);
            --tp-radius-sm: 8px;
            --tp-radius-md: 12px;
            --tp-radius-lg: 16px;
            --tp-map-chrome: #EDE8E0;
            --tp-focus-ring: 0 0 0 2px var(--tp-surface), 0 0 0 4px var(--tp-primary-muted);
          }
          /* Resizable pane drag handles */
          .trip-resize-handle:hover,
          .trip-resize-handle[data-resize-handle-active] {
            background: var(--tp-primary-muted) !important;
          }
          .trip-resize-handle:hover > div,
          .trip-resize-handle[data-resize-handle-active] > div {
            background: var(--tp-primary) !important;
            height: 48px !important;
          }
          /* overflow-x: hidden on <html> can clip vertical scroll on Chrome
             desktop when a child uses min-height:100vh. Keep it on body only. */
          body { overflow-x: hidden; }
          body {
            font-family: var(--tp-font-sans);
            margin: 0;
            padding: 0;
            background: var(--tp-bg);
            color: var(--tp-text);
            min-height: 100dvh;
            overscroll-behavior: none;
          }
          * { -webkit-tap-highlight-color: transparent; }
          /* Prevent iOS Safari from zooming on input focus */
          @supports (-webkit-touch-callout: none) {
            @media (max-width: 767px) {
              input, textarea, select { font-size: 16px !important; }
            }
          }
          img, svg, canvas { max-width: 100%; }

          /* ---- Trips / list pages responsive layout ---- */
          .page-main {
            flex: 1;
            max-width: 980px;
            margin: 0 auto;
            width: 100%;
            padding: 32px 24px;
            box-sizing: border-box;
          }
          .page-header {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 16px;
            flex-wrap: wrap;
            margin-bottom: 24px;
          }
          .page-title {
            font-size: 28px;
            font-weight: 700;
            margin: 0;
            color: var(--tp-text);
          }
          .page-eyebrow {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.15em;
            color: var(--tp-subtle);
            font-family: var(--tp-font-sans);
            margin-bottom: 4px;
            text-transform: uppercase;
          }
          .card-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
            gap: 12px;
          }
          @media (max-width: 767px) {
            .page-main { padding: 20px 14px 96px; }
            .page-title { font-size: 22px; }
            .page-header { margin-bottom: 16px; gap: 10px; }
            .card-grid { grid-template-columns: 1fr; gap: 10px; }
            .mobile-full { width: 100%; }
            .mobile-wrap { flex-wrap: wrap; }
          }

          /* ---- Animated loading dots ---- */
          @keyframes tp-dot-pulse {
            0%, 80%, 100% { opacity: 0.2; transform: translateY(0); }
            40% { opacity: 1; transform: translateY(-2px); }
          }
          @keyframes tp-cursor-blink {
            0%, 49% { opacity: 1; }
            50%, 100% { opacity: 0; }
          }
          @keyframes tp-new-trip-cue-pulse {
            0%, 100% {
              opacity: 1;
              transform: scale(1);
              box-shadow: 0 0 0 0 rgba(201, 123, 99, 0.55);
            }
            50% {
              opacity: 0.4;
              transform: scale(1.12);
              box-shadow: 0 0 0 7px rgba(201, 123, 99, 0);
            }
          }
          .new-trip-corner-cue {
            position: absolute;
            top: -4px;
            left: -4px;
            width: 12px;
            height: 12px;
            border-radius: 4px;
            background: var(--tp-accent-warm);
            pointer-events: none;
            z-index: 1;
            animation: tp-new-trip-cue-pulse 1.25s ease-in-out infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .new-trip-corner-cue {
              animation: none;
              opacity: 1;
              box-shadow: none;
              transform: none;
            }
          }
          .loading-dot {
            display: inline-block;
            animation: tp-dot-pulse 1.2s infinite ease-in-out both;
          }
        `}</style>
      </head>
      <body>
        {children}
        <ViewportTimeReporter />
        <ErrorNotifier />
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
