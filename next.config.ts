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

/**
 * Every file pdf.js needs at runtime that nothing statically imports.
 *
 * In Node, pdf.js has no real Worker: it loads its worker code in-process by
 * dynamically importing `./pdf.worker.mjs` relative to itself. A runtime
 * dynamic import is invisible to Next's file tracer, so the worker is not
 * shipped — and the deployed function fails on its first document with
 *
 *   Setting up fake worker failed: Cannot find module '…/pdf.worker.mjs'
 *
 * while passing locally, where node_modules is on disk. That failure mode is
 * the reason the Phase 3B spike exercised a real `next build` and read the
 * trace manifest rather than trusting a Node test.
 *
 * `tests/unit/pdf-worker-tracing.test.ts` asserts the worker is present in the
 * built `.nft.json` for the ingestion runtime, so this cannot silently stop
 * being true.
 */
const PDFJS_RUNTIME_FILES = ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"];

/**
 * Which entrypoints need it: all of them, and that is not over-caution.
 *
 * The obvious answer is "the cron route", because that is what drains the job
 * queue. It is wrong. `dispatchSoon()` in src/lib/events.ts is called after
 * ordinary writes — creating a task, moving a deal — and it drains whatever is
 * pending, which can include a `file.uploaded` queued minutes earlier. So
 * extraction can run inside a Server Action's function, and that function needs
 * the worker on disk exactly as much as the cron one does.
 *
 * Scoping this to /api/cron/jobs would therefore produce the *intermittent*
 * version of the Phase 3B failure: ingestion works when cron happens to pick
 * the job up, and throws when a user's save happens to pick it up first. That
 * is strictly harder to diagnose than failing every time.
 *
 * The cost is ~2.3 MB of worker per traced function, plus the 5.2 MB source map
 * the tracer pulls in beside it, against Vercel's 250 MB uncompressed limit.
 * `outputFileTracingExcludes` was tried for the map and does not work here:
 * an explicit include wins over an exclude, so the entry did nothing and was
 * removed rather than left in place looking effective.
 */
const INGESTION_ENTRYPOINTS = ["/**/*"];

const nextConfig: NextConfig = {
  // Prisma's driver adapters load native bindings, so they must resolve at
  // runtime rather than be traced into the bundle.
  //
  // pdfjs-dist is here for a different reason: bundling rewrites it into
  // .next/server/chunks/, which breaks the relative worker import described
  // above. Externalising it leaves the package resolvable from node_modules,
  // where that import works.
  serverExternalPackages: [
    "@prisma/adapter-better-sqlite3",
    "@prisma/adapter-pg",
    "better-sqlite3",
    "pdfjs-dist",
  ],

  outputFileTracingIncludes: Object.fromEntries(
    INGESTION_ENTRYPOINTS.map((route) => [route, PDFJS_RUNTIME_FILES]),
  ),

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
