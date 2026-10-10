/** @type {import('next').NextConfig} */
// /api/v1/* is owned by Next route handlers (httpOnly-cookie BFF).
// Never rewrite those requests directly to the backend, or browsers can
// bypass Origin/CSRF checks and inadvertently expose upstream bearer tokens.
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
    ] }];
  },
};
export default nextConfig;
