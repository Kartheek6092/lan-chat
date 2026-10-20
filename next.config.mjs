const isProd = process.env.NODE_ENV === 'production';

// Strict CSP in production. Next needs inline scripts for hydration; dev also needs eval for hot reload.
const csp = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' wss: ws:",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Cache-Control', value: 'no-store' },
      ],
    }];
  },
};

export default nextConfig;
