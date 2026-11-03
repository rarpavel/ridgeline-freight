import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The path comes from the database, so the file tracer can't see these files on its own.
  outputFileTracingIncludes: {
    '/api/documents/\\[id\\]/original': ['./data/corpus/**/*.docx'],
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
