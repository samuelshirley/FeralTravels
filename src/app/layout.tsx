import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Nordkapp Trip Planner',
  description: 'Map-first road trip planner — Girona to Nordkapp',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#7CB5E8',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
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
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js').catch(() => {});
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
