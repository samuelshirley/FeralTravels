/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
  // Output to a temp dir if on mounted filesystem
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

module.exports = nextConfig;
