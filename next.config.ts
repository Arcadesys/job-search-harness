import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname,
  },
  outputFileTracingIncludes: {
    '/api/jobs/drafting/pdf': ['./assets/fonts/*.ttf'],
  },
};

export default nextConfig;
