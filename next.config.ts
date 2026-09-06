import type { NextConfig } from "next";

import { STATIC_CSP } from "./src/lib/csp";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Security headers.
 *
 * The Content-Security-Policy is **not** here. It carries a per-request nonce
 * and is set in `src/proxy.ts` from `src/lib/csp.ts`; a static header cannot
 * carry a nonce, and without one `script-src 'self'` blocks Next's own inline
 * bootstrap and breaks hydration. Everything below is request-independent and
 * belongs in a static header.
 *
 * Responses that never pass through the proxy — API routes, static assets —
 * get the restrictive `STATIC_CSP` instead, since they contain no script.
 */

const securityHeaders = [
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
        // Nothing under /api should ever be cached by a shared cache. These
        // responses are JSON and never contain script, so they get the
        // restrictive policy rather than the nonced one.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "Content-Security-Policy", value: STATIC_CSP },
        ],
      },
    ];
  },
};

export default nextConfig;
