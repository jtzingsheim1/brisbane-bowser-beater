import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Version numbers stated in prose rot silently: a dependency or model bump
// lands and the doc keeps naming the old one (README said "AI SDK v6" for
// months after the move to v7). Docs name a version only where it changes how
// the code is written or what the system costs, and every one they do name is
// checked here against the file that actually pins it. A bump that fails this
// test needs the matching doc line updated in the same PR.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// Every committed Markdown file, so a new doc is covered without editing this
// list. Historical event records in PLAN.md (e.g. "Phase 4 shipped on AI SDK
// v6") are true as written, so PLAN.md is deliberately not scanned.
const DOCS = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((p) => p && p !== "PLAN.md");

// The MCP subproject pins its own dependencies, and its docs describe the
// Lambda runtime, so library majors are checked against the root package.json
// only outside it, and Node versions only inside it.
const isMcpDoc = (p: string) =>
  p.startsWith("mcp/") || p.startsWith("infra/") || p === "docs/mcp-rag-design.md";

const rootPkg = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** Major version of a root dependency from its package.json range. */
function major(name: string): string {
  const range = rootPkg.dependencies[name] ?? rootPkg.devDependencies[name];
  const m = range?.match(/(\d+)/);
  if (!m) throw new Error(`no version for ${name} in package.json`);
  return m[1];
}

/** Every version a pattern captures across the given docs. */
function stated(
  pattern: RegExp,
  docs: string[] = DOCS,
): { doc: string; version: string }[] {
  const found: { doc: string; version: string }[] = [];
  for (const doc of docs) {
    for (const m of read(doc).matchAll(pattern)) {
      found.push({ doc, version: m[1] });
    }
  }
  return found;
}

describe("versions stated in docs match what the repo pins", () => {
  const libraries: [string, RegExp, string][] = [
    ["Next.js", /Next\.js v?(\d+)/g, major("next")],
    ["React", /React v?(\d+)/g, major("react")],
    ["Tailwind", /Tailwind(?: CSS)? v?(\d+)/g, major("tailwindcss")],
    ["Vercel AI SDK", /AI SDK v?(\d+)/g, major("ai")],
    ["TypeScript", /TypeScript v?(\d+)/g, major("typescript")],
  ];

  for (const [label, pattern, expected] of libraries) {
    it(`${label} majors match package.json (${expected})`, () => {
      for (const s of stated(pattern, DOCS.filter((p) => !isMcpDoc(p)))) {
        expect(`${s.doc}: ${label} ${s.version}`).toBe(
          `${s.doc}: ${label} ${expected}`,
        );
      }
    });
  }

  it("the Claude Haiku version matches the Bedrock model id in infra/rag.tf", () => {
    const id = read("infra/rag.tf").match(/claude-haiku-(\d+)-(\d+)/);
    expect(id).not.toBeNull();
    const expected = `${id![1]}.${id![2]}`;
    const found = stated(/Haiku (\d+(?:\.\d+)?)/g);
    expect(found.length).toBeGreaterThan(0);
    for (const s of found) {
      expect(`${s.doc}: Haiku ${s.version}`).toBe(`${s.doc}: Haiku ${expected}`);
    }
  });

  it("the Node version stated for the Lambda matches infra/lambda.tf", () => {
    const runtime = read("infra/lambda.tf").match(/runtime\s*=\s*"nodejs(\d+)\.x"/);
    expect(runtime).not.toBeNull();
    for (const s of stated(/Node(?:\.js)? (\d+)/g, DOCS.filter(isMcpDoc))) {
      expect(`${s.doc}: Node ${s.version}`).toBe(`${s.doc}: Node ${runtime![1]}`);
    }
  });
});
