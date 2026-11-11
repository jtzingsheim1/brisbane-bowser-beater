import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Plain ESM script without type declarations, by design (it runs on the
// runner's Node with no install step); typed by the cast below.
import * as classifier from "../infra/scripts/classify-plan.mjs";

// The deploy workflow (.github/workflows/mcp-deploy.yml) applies a plan
// unattended only when infra/scripts/classify-plan.mjs routes it "routine".
// These tests pin that routing, and that the script never prints a value
// from the plan (the plan JSON carries prior state, sensitive values
// included, in plain text).
//
// The fixtures under tests/fixtures/plans/ are HAND-WRITTEN to Terraform's
// documented plan JSON format (format_version, resource_changes[] with
// address / type / change.actions / before / after / after_unknown,
// output_changes), not recorded from a real plan. Refresh them from a real
// `terraform show -json` of the locked provider (infra/.terraform.lock.hcl)
// when one is available, stripping account ids and every secret value, and
// keep the sentinel string in place of the secrets so the no-values test
// below keeps its teeth.
//
// Like every check on this path, this is an accident guard, not a security
// control (docs/mcp-auto-deploy-design.md section 4).

type Entry = {
  address: string;
  actions: string[];
  verdict: "routine" | "gated";
  reason: string;
  corpus: boolean;
};
type Result = {
  route: "routine" | "gated" | "noop";
  corpusSync: boolean;
  entries: Entry[];
  notes: string[];
};
const { classifyPlan, formatLines, formatSummary, changedAttributes } =
  classifier as unknown as {
    classifyPlan: (plan: unknown) => Result;
    formatLines: (r: Result) => string[];
    formatSummary: (r: Result, title?: string) => string;
    changedAttributes: (change: unknown) => string[];
  };

const SCRIPT = join(process.cwd(), "infra/scripts/classify-plan.mjs");
const FIXTURES = join(process.cwd(), "tests/fixtures/plans");
const SENTINEL = "SENTINEL-SECRET-0d1e-do-not-print";

const fixturePath = (name: string) => join(FIXTURES, `${name}.json`);
const load = (name: string): unknown =>
  JSON.parse(readFileSync(fixturePath(name), "utf8"));
const classify = (name: string) => classifyPlan(load(name));

describe("routing", () => {
  it.each([
    // [fixture, route, corpus_sync]
    ["code-update", "routine", false],
    ["tag-update", "routine", false],
    ["outputs-only", "routine", false],
    ["noop", "noop", false],
    ["config-update", "gated", false],
    ["iam-update", "gated", false],
    ["tag-update-log-group", "gated", false],
    ["create", "gated", true],
    ["delete", "gated", false],
    ["replace-delete-create", "gated", true],
    ["replace-create-delete", "gated", false],
    ["forget-backstop", "gated", false],
    ["forget-other", "gated", false],
    ["kb-update", "gated", true],
    ["import", "gated", false],
    ["moved", "gated", false],
  ] as const)("%s routes %s (corpus_sync=%s)", (name, route, corpus) => {
    const r = classify(name);
    expect(r.route).toBe(route);
    expect(r.corpusSync).toBe(corpus);
  });

  it("names the attributes that gate a config update", () => {
    const [entry] = classify("config-update").entries;
    expect(entry.verdict).toBe("gated");
    expect(entry.reason).toContain("environment");
  });

  it("reads Lambda code churn as only the allow-listed attributes", () => {
    const plan = load("code-update") as {
      resource_changes: { address: string; change: unknown }[];
    };
    const lambda = plan.resource_changes.find(
      (rc) => rc.address === "aws_lambda_function.server",
    )!;
    expect(changedAttributes(lambda.change)).toEqual([
      "code_sha256",
      "last_modified",
      "qualified_arn",
      "qualified_invoke_arn",
      "source_code_hash",
      "source_code_size",
      "version",
    ]);
  });

  it("gates a known new value for an unknown-only attribute", () => {
    const plan = load("code-update") as {
      resource_changes: {
        address: string;
        change: { after: Record<string, unknown>; after_unknown: Record<string, unknown> };
      }[];
    };
    const lambda = plan.resource_changes.find(
      (rc) => rc.address === "aws_lambda_function.server",
    )!;
    delete lambda.change.after_unknown.version;
    lambda.change.after.version = "7";
    expect(classifyPlan(plan).route).toBe("gated");
  });

  it("gates an update to a type with no allow-list, even tags only", () => {
    const plan = load("tag-update") as {
      resource_changes: { type: string; address: string }[];
    };
    plan.resource_changes[0].type = "aws_iam_role";
    plan.resource_changes[0].address = "aws_iam_role.server_exec";
    expect(classifyPlan(plan).route).toBe("gated");
  });

  it("gates an errored or incomplete plan", () => {
    const noop = load("noop") as Record<string, unknown>;
    expect(classifyPlan({ ...noop, errored: true }).route).toBe("gated");
    expect(classifyPlan({ ...noop, complete: false }).route).toBe("gated");
  });

  it("treats an empty plan as noop", () => {
    expect(classifyPlan({ format_version: "1.2" }).route).toBe("noop");
  });
});

describe("output never carries a value from the plan", () => {
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  it("at least one fixture holds the sentinel", () => {
    const holding = names.filter((n) =>
      readFileSync(fixturePath(n), "utf8").includes(SENTINEL),
    );
    expect(holding.length).toBeGreaterThan(3);
  });

  it.each(names)("%s: lines and summary omit the sentinel", (name) => {
    const r = classify(name);
    expect(formatLines(r).join("\n")).not.toContain(SENTINEL);
    expect(formatSummary(r)).not.toContain(SENTINEL);
  });

  const dir = mkdtempSync(join(tmpdir(), "classify-plan-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(["code-update", "config-update", "outputs-only", "forget-backstop"])(
    "%s: the CLI's stdout, GITHUB_OUTPUT and step summary omit the sentinel",
    (name) => {
      const out = join(dir, `${name}.out`);
      const summary = join(dir, `${name}.md`);
      const stdout = execFileSync("node", [SCRIPT, fixturePath(name)], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
      });
      const expected = classify(name);
      expect(stdout).not.toContain(SENTINEL);
      expect(readFileSync(summary, "utf8")).not.toContain(SENTINEL);
      const outputs = readFileSync(out, "utf8");
      expect(outputs).not.toContain(SENTINEL);
      expect(outputs).toMatch(
        new RegExp(
          `^route=${expected.route}\\ncorpus_sync=${expected.corpusSync}\\n` +
            `summary<<(CLASSIFY_[0-9a-f-]+)\\n[^]*\\n\\1\\n$`,
        ),
      );
      expect(outputs).toContain(formatLines(expected).join("\n"));
    },
  );
});
