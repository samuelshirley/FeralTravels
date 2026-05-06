/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
  // Output to a temp dir if on mounted filesystem
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // Prevent Vercel / CDN from caching HTML pages. Hashed static assets
  // (/_next/static/) are immutable and cached forever by default; this only
  // affects document (HTML) and API responses so users always get the latest
  // deploy on refresh instead of a stale cached version.
  async headers() {
    return [
      {
        // All pages — no CDN/browser caching of HTML
        source: '/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, must-revalidate',
          },
        ],
      },
      {
        // Let hashed immutable assets keep long-lived caching
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
