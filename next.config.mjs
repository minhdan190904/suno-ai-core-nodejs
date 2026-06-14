/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['rebrowser-playwright-core', 'ghost-cursor-playwright', '@2captcha/captcha-solver'],
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
  outputFileTracingRoot: '/opt/suno-api',
};  

export default nextConfig;
