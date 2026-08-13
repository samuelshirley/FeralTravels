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
      // Preview deployments serve a CLONE OF PRODUCTION DATA on a public URL
      // (see .github/workflows/ci.yml). They must never be indexed. Only
      // VERCEL_ENV=production is exempt.
      ...(process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production'
        ? [
            {
              source: '/:path*',
              headers: [
                { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
              ],
            },
          ]
        : []),
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
