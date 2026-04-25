import type { Metadata, Viewport } from 'next';
import ErrorNotifier from '@/components/ErrorNotifier';

export const metadata: Metadata = {
  title: 'Feral Travels',
  description: 'Map-first overlanding trip planner — Feral Travels',
  manifest: '/manifest.json',
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
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
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
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js').then((reg) => {
                    // Check for a new SW on every page load so a deploy propagates
                    // without the user having to fully close the tab.
                    reg.update().catch(() => {});
                    reg.addEventListener('updatefound', () => {
                      const sw = reg.installing;
                      if (!sw) return;
                      sw.addEventListener('statechange', () => {
                        // New worker is ready but waiting because the old one is
                        // still controlling the page. Tell it to activate now
                        // and reload so the user sees the new build immediately.
                        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                          sw.postMessage({ type: 'SKIP_WAITING' });
                        }
                      });
                    });
                    let reloaded = false;
                    navigator.serviceWorker.addEventListener('controllerchange', () => {
                      if (reloaded) return;
                      reloaded = true;
                      window.location.reload();
                    });
                  }).catch(() => {});
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
