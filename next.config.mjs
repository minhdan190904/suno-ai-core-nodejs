/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(ttf|html)$/i,
      type: 'asset/resource'
    });
    return config;
  },
  experimental: {
    serverMinification: false, // the server minification unfortunately breaks the selector class names
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn1.suno.ai' },
      { protocol: 'https', hostname: 'cdn2.suno.ai' },
      { protocol: 'https', hostname: 'cdn-o.suno.com' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
    ];
  },
};  

export default nextConfig;
