import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Content-Security-Policy.
 *
 * The two loosenings are deliberate and documented, not oversights:
 *
 *  - `'unsafe-inline'` on style-src: Next injects inline `<style>` for CSS-in-JS
 *    and Tailwind's critical CSS, and there is no nonce plumbing for it. Style
 *    injection is a defacement risk rather than a script-execution one.
 *  - `'unsafe-inline'` on script-src in development only: React refresh and the
 *    dev overlay need it. Production omits it entirely.
 *
 * Production keeps `'unsafe-eval'` off, so `eval` and `new Function` cannot run
 * even if an injection reaches the page. `frame-ancestors 'none'` and
 * `object-src 'none'` close clickjacking and plugin-based execution.
 *
 * `connect-src` includes the AI providers because Tiny AI calls them from the
 * server; browser calls only ever go to same-origin routes, so this could be
 * tightened to `'self'` once no client-side provider call is possible.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self'${isProduction ? "" : " 'unsafe-inline' 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "worker-src 'self' blob:",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Legacy equivalent of frame-ancestors, for browsers that predate CSP 2.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // Nothing in this app needs these; denying them limits what an injected
    // script could reach.
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          // Two years, subdomains included. `preload` is intentionally omitted:
          // submitting to the preload list is effectively irreversible and
          // should be a deliberate operational decision, not a default.
          value: "max-age=63072000; includeSubDomains",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Prisma's driver adapters load native bindings, so they must resolve at
  // runtime rather than be traced into the bundle.
  serverExternalPackages: [
    "@prisma/adapter-better-sqlite3",
    "@prisma/adapter-pg",
    "better-sqlite3",
  ],
  typedRoutes: true,

  // Never advertise the framework version to a scanner.
  poweredByHeader: false,

  images: {
    // Narrowed from the prototype's `hostname: "**"`, which would have let any
    // origin be proxied through the image optimiser.
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Nothing under /api should ever be cached by a shared cache.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
