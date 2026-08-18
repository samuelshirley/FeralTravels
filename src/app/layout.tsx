import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Onest } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
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
  themeColor: '#4E7AB0',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={onest.variable}>
      <body>
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
