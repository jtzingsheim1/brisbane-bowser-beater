import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Vercel already redirects HTTP→HTTPS and enforces TLS at the edge,
          // so HSTS is belt-and-braces — it covers the narrow window where a
          // first-time visitor's initial HTTP request could be intercepted
          // before the redirect. 2-year max-age is the OWASP-recommended value.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // Content Security Policy, deliberately scoped to the directives
          // that close a real attack class here without constraining script
          // execution.
          //
          // What is NOT set, and why: a `script-src` worth having would need
          // per-request nonces, because the App Router injects inline scripts
          // for hydration and streaming. That means a `proxy.ts` minting a
          // nonce on every HTML request, and threading it through. (Nonces
          // also require dynamic rendering, but that costs nothing here --
          // `connection()` in the root layout already makes every page
          // dynamic.) The alternative, `script-src 'self' 'unsafe-inline'`,
          // permits exactly the injection a CSP is meant to stop, so it would
          // buy a header that reads protective and is not.
          //
          // Paying that cost would be worth it against a real XSS surface.
          // There isn't one today: no `dangerouslySetInnerHTML`, no inline
          // script tags, no `eval`, and the only user-supplied text rendered
          // is agent output through react-markdown, which builds React
          // elements rather than parsing HTML. Revisit if any of those
          // change -- that list is the trigger, not a general reassurance.
          //
          // The four directives below need no nonce and cannot break a page
          // that behaves as this one does: no base tag, no plugins, never
          // framed, forms posting only to this origin. `form-action` is the
          // one to check when adding an off-site payment or auth flow -- the
          // tip jar is unaffected because it reaches Stripe by
          // `window.location.assign`, a navigation rather than a form post.
          {
            key: "Content-Security-Policy",
            value: [
              "base-uri 'none'",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
