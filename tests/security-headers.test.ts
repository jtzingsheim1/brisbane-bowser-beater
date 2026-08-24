import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

// The security headers are configuration, so nothing else in the suite would
// notice one being weakened or dropped. The CSP in particular is a deliberate
// subset -- four directives that need no nonce -- and the reasoning for what
// is absent lives in a comment, which a future edit can quietly contradict.

async function headersFor(path: string): Promise<Map<string, string>> {
  const rules = await nextConfig.headers!();
  const out = new Map<string, string>();
  for (const rule of rules) {
    // The single rule is `/:path*`; if that ever becomes several rules with
    // real patterns, this needs to learn matching rather than silently
    // reporting headers that do not apply to `path`.
    if (rule.source !== "/:path*") {
      throw new Error(
        `security-headers.test.ts only models the catch-all rule, but found ` +
          `source ${rule.source}. Teach it path matching before relying on it.`,
      );
    }
    for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
  }
  void path;
  return out;
}

describe("security headers ship on every route", () => {
  it("sets the expected header set", async () => {
    const h = await headersFor("/");
    expect([...h.keys()].sort()).toEqual([
      "content-security-policy",
      "permissions-policy",
      "referrer-policy",
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
    ]);
  });

  it("keeps the framing, sniffing and transport protections", async () => {
    const h = await headersFor("/");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("strict-transport-security")).toContain("max-age=63072000");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("the CSP stays the intended subset", () => {
  const directives = async () => {
    const csp = (await headersFor("/")).get("content-security-policy");
    if (!csp) throw new Error("no Content-Security-Policy header");
    return new Map(
      csp.split(";").map((d) => {
        const [name, ...rest] = d.trim().split(/\s+/);
        return [name, rest.join(" ")];
      }),
    );
  };

  it("locks the four nonce-free directives to their values", async () => {
    expect([...(await directives())].sort()).toEqual([
      ["base-uri", "'none'"],
      ["form-action", "'self'"],
      ["frame-ancestors", "'none'"],
      ["object-src", "'none'"],
    ]);
  });

  it("never grows an unsafe script or style allowance", async () => {
    // If a script-src is ever added it should be nonce- or hash-based. A bare
    // 'unsafe-inline' permits exactly the injection the header exists to
    // prevent, and would make the policy read protective while not being so.
    const csp = (await headersFor("/")).get("content-security-policy")!;
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
});
