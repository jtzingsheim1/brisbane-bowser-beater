import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The ungated corpus-sync workflow (.github/workflows/corpus-sync.yml) and
// the MCP deploy workflow (.github/workflows/mcp-deploy.yml) make claims that
// live in prose and could drift silently. For corpus-sync:
//
//   * Its push trigger fires for exactly the files that feed the knowledge
//     base -- the corpus manifest plus the workflow's own inputs. A manifest
//     entry missing from the paths filter means that doc silently stops
//     re-ingesting on merge, which is the exact failure this workflow was
//     built to end.
//   * It stays a docs publisher: no Terraform, no environment gate, and the
//     ingestion logic lives only in the shared script both workflows call,
//     so the two cannot diverge.
//
// For mcp-deploy (docs/mcp-auto-deploy-design.md sections 5.3 and 7): it
// fires on push to main for the MCP paths (markdown excluded) and on
// dispatch; its build job mints no token; the `aws` (unattended update
// role) and `aws-gated` (approved deploy role) environments appear nowhere
// else; and destroy is reachable only by dispatch, only in deploy-gated.
// Across ALL workflows, every job that can mint an OIDC token declares an
// environment, so none falls back to the main-ref subject the corpus-sync
// role trusts; corpus-sync's own job is the one pinned exception.
//
// Like every check on this path these are accident guards, not controls:
// workflow code and tests on main are attacker-controlled in the design's
// threat model (section 4). IAM and role trust are the controls.
//
// Parsed with line-level string handling rather than a YAML library on
// purpose: the shapes asserted here are simple lists and top-level keys, and
// a parse this dumb cannot be fooled by anchors or merges into seeing
// structure that is not literally in the file.

const ROOT = process.cwd();
const CORPUS_SYNC = ".github/workflows/corpus-sync.yml";
const MCP_DEPLOY = ".github/workflows/mcp-deploy.yml";
const SYNC_SCRIPT = "mcp/scripts/sync-corpus.sh";
const MANIFEST = "mcp/corpus-manifest.txt";

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Workflow filenames. GitHub does not recurse below this directory. */
function workflowFiles(): string[] {
  return readdirSync(join(ROOT, ".github/workflows")).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );
}

/** Drops whole-line comments, so prose about a construct is not mistaken
 * for the construct itself. Trailing comments are handled by the patterns. */
const uncommented = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/**
 * Does a workflow grant itself an OIDC token? Three spellings reach it, and
 * a guard that caught only the first would read as protective while missing
 * the two most likely ways someone adds it without thinking:
 *   permissions:\n  id-token: write   (plain, quoted, or with a comment)
 *   permissions: write-all            (grants every scope, id-token included)
 *   permissions: { id-token: write }  (flow mapping)
 */
function grantsOidcToken(text: string): boolean {
  return (
    /^\s*id-token:\s*['"]?write['"]?\s*(#.*)?$/m.test(text) ||
    /^\s*permissions:\s*['"]?write-all['"]?\s*(#.*)?$/m.test(text) ||
    /\{[^}\n]*id-token\s*:/.test(text)
  );
}

function manifestEntries(): string[] {
  return read(MANIFEST)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The `paths:` list under the push trigger, as literal strings (one
 * level of quotes stripped). Comment lines inside the list are skipped. */
function pushPaths(text: string): string[] {
  const lines = uncommented(text).split("\n");
  const start = lines.findIndex((l) => /^    paths:\s*$/.test(l));
  if (start === -1) throw new Error("workflow has no push paths filter");
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^      - (\S+)\s*$/.exec(line);
    if (!m) break;
    out.push(m[1].replace(/^(["'])(.*)\1$/, "$2"));
  }
  if (out.length === 0) throw new Error("push paths filter is empty");
  return out;
}

/** Top-level keys of the `on:` block. */
function triggerKeys(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (start === -1) throw new Error("workflow has no on: block");
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^  ([A-Za-z_]+):/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Each job's block (whole-line comments dropped), keyed by job id. */
function jobs(text: string): Map<string, string> {
  const lines = uncommented(text).split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) throw new Error("workflow has no jobs: block");
  const out = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      if (name) out.set(name, body.join("\n"));
      name = m[1];
      body = [];
    } else if (name) {
      body.push(line);
    }
  }
  if (name) out.set(name, body.join("\n"));
  return out;
}

/** A top-level key's block within `block` at `indent` spaces: the key's own
 * line plus the deeper-indented lines under it. Empty when absent. */
function keyBlock(block: string, key: string, indent: number): string {
  const pad = " ".repeat(indent);
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${pad}${key}:`));
  if (start === -1) return "";
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith(`${pad} `)) break;
    out.push(line);
  }
  return out.join("\n");
}

/** Can this job mint an OIDC token? Its own permissions block if it has
 * one, else the workflow-level block it inherits. */
function jobGrantsOidc(workflow: string, job: string): boolean {
  const own = keyBlock(job, "permissions", 4);
  const perms = own || keyBlock(uncommented(workflow), "permissions", 0);
  return grantsOidcToken(perms.replace(/^ {2,4}permissions:/m, "permissions:"));
}

/** The environment a job declares (scalar form), "" when none. */
function jobEnvironment(job: string): string {
  const m = /^    environment:\s*['"]?([^'"\s#]*)['"]?/m.exec(job);
  return m ? m[1] : "";
}

/** A job's `if:` condition, folded scalars joined into one line. */
function jobIf(job: string): string {
  return keyBlock(job, "if", 4)
    .replace(/^    if:\s*(>-)?/, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the corpus-sync workflow fires for exactly the corpus", () => {
  it("its paths filter is the manifest plus its own inputs", () => {
    const expected = [
      ...manifestEntries(),
      MANIFEST,
      SYNC_SCRIPT,
      CORPUS_SYNC,
    ].sort();
    expect(
      pushPaths(read(CORPUS_SYNC)).sort(),
      `the paths filter in ${CORPUS_SYNC} must list exactly the files in ` +
        `${MANIFEST} plus the manifest, the sync script, and the workflow ` +
        `itself -- an entry missing here silently stops re-ingesting on merge`,
    ).toEqual(expected);
  });

  it("every path it watches exists in the repo", () => {
    for (const p of pushPaths(read(CORPUS_SYNC))) {
      expect(() => readFileSync(join(ROOT, p)), p).not.toThrow();
    }
  });
});

describe("only the two known workflows can mint AWS credentials", () => {
  // The corpus-sync role's trust policy pins the OIDC subject
  // `repo:...:ref:refs/heads/main`, which restricts by REF, not by event:
  // any job in this repo running on the main ref that requests an OIDC
  // token produces a matching subject, whatever triggered it. AWS web
  // identity federation can only condition on aud/azp/amr/sub, so there is
  // no trust-policy clause that could narrow this to one workflow file --
  // the narrowing has to be enforced here instead.
  //
  // Hence this guard: adding `id-token: write` to any other workflow --
  // most dangerously a `pull_request_target` one, which runs with full
  // permissions on the base ref and is triggerable by an outside
  // contributor -- would silently extend who can assume the ungated role
  // and republish what the docs tools serve. Doing that should be a
  // deliberate, reviewed act, so it fails the build first.
  it("no other workflow requests an OIDC token", () => {
    const requesting = workflowFiles()
      .filter((f) => grantsOidcToken(uncommented(read(`.github/workflows/${f}`))))
      .sort();
    expect(
      requesting,
      "a workflow gained `id-token: write`. It can now assume an AWS role " +
        "via OIDC -- and if it runs on main, the corpus-sync role's " +
        "ref-pinned trust policy will match it. Confirm that is intended, " +
        "and that the workflow is not `pull_request_target` (which an " +
        "outside contributor can trigger), before adding it here.",
    ).toEqual(["corpus-sync.yml", "mcp-deploy.yml"]);
  });

  it("every job that can mint a token declares an environment, but corpus-sync's", () => {
    // A job with a token and no environment gets the subject
    // `repo:...:ref:refs/heads/main` on main, which is exactly what the
    // ungated corpus-sync role trusts. Every other token-holding job must
    // declare an environment so its subject names that environment instead.
    // corpus-sync's sync job is the deliberate exception (pinned here, so a
    // second one fails the build).
    const withoutEnvironment: string[] = [];
    let tokenJobs = 0;
    for (const f of workflowFiles()) {
      const text = read(`.github/workflows/${f}`);
      for (const [name, job] of jobs(text)) {
        if (!jobGrantsOidc(text, job)) continue;
        tokenJobs++;
        if (jobEnvironment(job) === "") withoutEnvironment.push(`${f}:${name}`);
      }
    }
    expect(tokenJobs, "the job parser found no token-holding jobs").toBeGreaterThan(2);
    expect(withoutEnvironment).toEqual(["corpus-sync.yml:sync"]);
  });

  it("the aws and aws-gated environments are declared only by mcp-deploy", () => {
    const declaring: string[] = [];
    for (const f of workflowFiles()) {
      const code = uncommented(read(`.github/workflows/${f}`));
      // The mapping form (`environment:` then `name: aws`) would dodge the
      // scalar parse in jobEnvironment, so it is not allowed at all.
      expect(code, `${f} uses the mapping form of environment:`).not.toMatch(
        /^\s*environment:\s*$/m,
      );
      if (/^\s*environment:\s*['"]?aws(-gated)?['"]?\s*(#.*)?$/m.test(code)) {
        declaring.push(f);
      }
    }
    expect(declaring).toEqual(["mcp-deploy.yml"]);
  });

  it("no workflow uses pull_request_target", () => {
    const offenders = workflowFiles().filter((f) =>
      // Block form (`pull_request_target:` on its own line) and the inline
      // forms (`on: [push, pull_request_target]`, `on: pull_request_target`).
      /(^\s*pull_request_target\s*:)|(^\s*on:.*\bpull_request_target\b)/m.test(
        uncommented(read(`.github/workflows/${f}`)),
      ),
    );
    expect(
      offenders,
      "pull_request_target runs with full repository permissions in the " +
        "base-branch context and is triggerable by anyone who can open a " +
        "pull request. Combined with an OIDC token it is the most likely " +
        "route to an outsider assuming the ungated corpus-sync role.",
    ).toEqual([]);
  });
});

describe("the corpus-sync workflow stays a docs publisher", () => {
  it("triggers on push to main and manual dispatch, nothing else", () => {
    expect(triggerKeys(read(CORPUS_SYNC)).sort()).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    const text = read(CORPUS_SYNC);
    expect(text).toContain("branches: [main]");
  });

  it("declares no environment and runs no Terraform", () => {
    // Ungated is the design (see infra/BOOTSTRAP.md section 3c); this pins
    // that the workflow also never grows the reach that would make ungated
    // unsafe. Terraform appearing here would mean infra changes riding an
    // unapproved push.
    const text = read(CORPUS_SYNC);
    // Comments may say the word (the security-model header does); the check
    // is about executable content.
    const code = text
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toMatch(/^\s*environment:/m);
    expect(code.toLowerCase()).not.toContain("terraform");
    expect(code).toContain("vars.AWS_CORPUS_SYNC_ROLE_ARN");
    expect(code).not.toContain("vars.AWS_ROLE_ARN");
  });

  it("carries no destroy option", () => {
    expect(read(CORPUS_SYNC)).not.toContain("destroy");
  });

  it("both workflows share the one sync script", () => {
    // The ingestion commands living only in the script is what keeps the
    // gated and ungated paths identical in behaviour.
    expect(read(CORPUS_SYNC)).toContain(SYNC_SCRIPT);
    expect(read(MCP_DEPLOY)).toContain(SYNC_SCRIPT);
    for (const wf of [CORPUS_SYNC, MCP_DEPLOY]) {
      expect(read(wf)).not.toContain("start-ingestion-job");
    }
    expect(read(SYNC_SCRIPT)).toContain("start-ingestion-job");
  });
});

describe("the mcp-deploy workflow keeps its shape", () => {
  const text = read(MCP_DEPLOY);
  const code = uncommented(text);
  const j = jobs(text);

  it("triggers on push to main and manual dispatch, nothing else", () => {
    expect(triggerKeys(text).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(code).toContain("branches: [main]");
  });

  it("its push paths filter is the MCP paths, markdown excluded last", () => {
    // GitHub evaluates the list in order and the last match wins, so the
    // negation must come after every positive pattern.
    expect(pushPaths(text)).toEqual([
      "mcp/**",
      "infra/**",
      "analysis/output/cycle_params.json",
      ".github/workflows/mcp-deploy.yml",
      "!**/*.md",
    ]);
  });

  it("has the five expected jobs and grants nothing at workflow level", () => {
    expect([...j.keys()].sort()).toEqual(
      ["build", "deploy", "deploy-gated", "notify-gated", "report"].sort(),
    );
    expect(code).toMatch(/^permissions: \{\}\s*$/m);
    // A dispatched plan has its own group so it can never cancel a push
    // deploy pending in the deploy group; everything else shares one.
    expect(code).toContain(
      "concurrency:\n  group: mcp-deploy${{ github.event_name == 'workflow_dispatch' && inputs.action == 'plan' && '-plan' || '' }}\n  cancel-in-progress: false\n",
    );
  });

  it("report waits for every other job, notify-gated included", () => {
    // Without notify-gated in needs, a rejected approval could race it
    // into opening a second issue, and a failed notification would go
    // unreported.
    expect(code).toMatch(/^  report:\n    needs: \[build, deploy, deploy-gated, notify-gated\]$/m);
    expect(jobIf(j.get("report")!)).toContain("!cancelled()");
  });

  it("build mints no token and declares no environment", () => {
    const build = j.get("build")!;
    expect(jobGrantsOidc(text, build)).toBe(false);
    expect(jobEnvironment(build)).toBe("");
    expect(build).not.toContain("configure-aws-credentials");
  });

  it("deploy uses the update role in aws; deploy-gated the deploy role in aws-gated", () => {
    const deploy = j.get("deploy")!;
    const gated = j.get("deploy-gated")!;
    expect(jobEnvironment(deploy)).toBe("aws");
    expect(jobEnvironment(gated)).toBe("aws-gated");
    expect(jobGrantsOidc(text, deploy)).toBe(true);
    expect(jobGrantsOidc(text, gated)).toBe(true);
    expect(deploy).toContain("vars.AWS_UPDATE_ROLE_ARN");
    expect(deploy).not.toContain("vars.AWS_ROLE_ARN");
    expect(gated).toContain("vars.AWS_ROLE_ARN");
    expect(gated).not.toContain("vars.AWS_UPDATE_ROLE_ARN");
    expect(code.match(/vars\.AWS_UPDATE_ROLE_ARN/g)).toHaveLength(1);
    expect(code.match(/vars\.AWS_ROLE_ARN/g)).toHaveLength(1);
  });

  it("the notification jobs hold issues: write and no AWS access", () => {
    for (const name of ["notify-gated", "report"]) {
      const job = j.get(name)!;
      expect(jobGrantsOidc(text, job), name).toBe(false);
      expect(jobEnvironment(job), name).toBe("");
      expect(keyBlock(job, "permissions", 4), name).toMatch(/^      issues: write$/m);
    }
  });

  it("destroy is reachable only by dispatch, and only in deploy-gated", () => {
    // `destroy` is only a workflow_dispatch choice: push events carry no
    // inputs. No job runs `terraform destroy`; the gated job plans with
    // -destroy and applies that saved plan.
    expect(code).not.toMatch(/terraform\s+destroy/);
    for (const [name, job] of j) {
      if (name === "deploy-gated") continue;
      expect(job, name).not.toMatch(/(^|\s)-destroy\b/);
    }
    expect(j.get("deploy-gated")!).toMatch(/mode=\(-destroy\)/);
    expect(jobIf(j.get("deploy-gated")!)).toContain(
      "(github.event_name == 'workflow_dispatch' && inputs.action == 'destroy')",
    );
    expect(jobIf(j.get("deploy")!)).toContain(
      "!(github.event_name == 'workflow_dispatch' && inputs.action == 'destroy')",
    );
    const onBlock = code.slice(code.indexOf("\non:"), code.indexOf("\njobs:"));
    expect(onBlock.indexOf("destroy")).toBeGreaterThan(onBlock.indexOf("workflow_dispatch:"));
  });

  it("every deploy job runs only on main", () => {
    for (const name of ["build", "deploy", "deploy-gated", "report"]) {
      expect(jobIf(j.get(name)!), name).toContain("github.ref == 'refs/heads/main'");
    }
  });
});
