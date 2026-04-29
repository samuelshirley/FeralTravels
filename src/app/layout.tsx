import type { Metadata, Viewport } from 'next';
import ErrorNotifier from '@/components/ErrorNotifier';

export const metadata: Metadata = {
  title: 'Feral Travels',
  description: 'Map-first overlanding trip planner — Feral Travels',
  manifest: '/manifest.json',
  openGraph: {
    title: 'Feral Travels',
    description: 'Map-first road trip planner.',
    siteName: 'Feral Travels',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Feral Travels',
    description: 'Map-first road trip planner.',
  },
};

// Note: width / initialScale / maximumScale are intentionally NOT set here
// because we render an explicit <meta name="viewport"> below that adds
// `interactive-widget=resizes-content` (iOS 17+ Safari soft-keyboard hint).
// The Next.js `viewport` export doesn't expose interactive-widget, so we
// emit the meta tag manually and limit this export to themeColor.
export const viewport: Viewport = {
  themeColor: '#7CB5E8',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, interactive-widget=resizes-content"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"
        />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Feral" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
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
          /* Resizable pane drag handles */
          .trip-resize-handle:hover,
          .trip-resize-handle[data-resize-handle-active] {
            background: rgba(124, 181, 232, 0.35) !important;
          }
          .trip-resize-handle:hover > div,
          .trip-resize-handle[data-resize-handle-active] > div {
            background: #7CB5E8 !important;
            height: 48px !important;
          }
          html, body { overflow-x: hidden; }
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
          }
          .page-eyebrow {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.15em;
            color: rgba(255,255,255,0.3);
            font-family: 'JetBrains Mono', monospace;
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
          .loading-dot {
            display: inline-block;
            animation: tp-dot-pulse 1.2s infinite ease-in-out both;
          }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          fontFamily: "'Inter', 'Helvetica Neue', sans-serif",
          background: '#0D0D0D',
          color: '#fff',
          minHeight: '100vh',
          overscrollBehavior: 'none',
        }}
      >
        {children}
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
