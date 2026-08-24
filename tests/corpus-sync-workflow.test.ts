import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The ungated corpus-sync workflow (.github/workflows/corpus-sync.yml) makes
// two claims that live in prose and could drift silently:
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

function manifestEntries(): string[] {
  return read(MANIFEST)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The `paths:` list under the push trigger, as literal strings. */
function pushPaths(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^    paths:\s*$/.test(l));
  if (start === -1) throw new Error(`${CORPUS_SYNC} has no push paths filter`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^      - (\S+)\s*$/.exec(line);
    if (!m) break;
    out.push(m[1]);
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
    const dir = join(ROOT, ".github/workflows");
    const requesting = readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .filter((f) => /^\s*id-token:\s*write\s*$/m.test(read(`.github/workflows/${f}`)))
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

  it("no workflow uses pull_request_target", () => {
    const dir = join(ROOT, ".github/workflows");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .filter((f) => /^\s*pull_request_target:/m.test(read(`.github/workflows/${f}`)));
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

  it("the destroy action stays out of reach of push events", () => {
    // Only the human-dispatched, environment-gated deploy workflow may carry
    // a destroy option.
    expect(triggerKeys(read(MCP_DEPLOY))).toEqual(["workflow_dispatch"]);
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
