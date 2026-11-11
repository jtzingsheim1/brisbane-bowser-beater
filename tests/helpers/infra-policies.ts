import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HclExpression, HclReader, type HclValue } from "./hcl-policy";

// Reads the IAM facts the boundary guard compares, from the two places this
// repo keeps them: the Terraform stack (infra/*.tf) and the human-run
// CloudShell bootstrap script embedded in infra/BOOTSTRAP.md.
//
// The two are deliberately separate artifacts (the boundaries must not be
// Terraform-managed, or the deploy could widen its own ceiling), which is
// exactly why they can drift apart with nothing to catch it.

export const INFRA_DIR = join(process.cwd(), "infra");

// Stand-ins for the shell variables the bootstrap script interpolates. Values
// are arbitrary but must be substituted before JSON.parse: the guard compares
// the *shape* of the ARNs, never these.
export const PLACEHOLDER_ACCOUNT_ID = "111122223333";
export const PLACEHOLDER_REGION = "ap-southeast-2";

// The subject prefix, and each role's subject as the tail GitHub appends to
// it. The script derives every subject from the one prefix; the guard checks
// that derivation literally (bootstrapShellAssignments), so the placeholders
// here only need to use the same tails.
const PLACEHOLDER_REPO_SUB = "repo:owner@1/repo@2";
export const SUBJECT_TAILS = {
  DEPLOY_SUB: ":environment:aws-gated",
  UPDATE_SUB: ":environment:aws",
  CORPUS_SYNC_SUB: ":ref:refs/heads/main",
} as const;

const SHELL_VARS: Record<string, string> = {
  REGION: PLACEHOLDER_REGION,
  ACCOUNT_ID: PLACEHOLDER_ACCOUNT_ID,
  STATE_BUCKET: `bbb-mcp-tfstate-${PLACEHOLDER_ACCOUNT_ID}`,
  OIDC_URL: "token.actions.githubusercontent.com",
  OIDC_ARN: `arn:aws:iam::${PLACEHOLDER_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`,
  GITHUB_REPO_SUB: PLACEHOLDER_REPO_SUB,
  DEPLOY_SUB: PLACEHOLDER_REPO_SUB + SUBJECT_TAILS.DEPLOY_SUB,
  UPDATE_SUB: PLACEHOLDER_REPO_SUB + SUBJECT_TAILS.UPDATE_SUB,
  CORPUS_SYNC_SUB: PLACEHOLDER_REPO_SUB + SUBJECT_TAILS.CORPUS_SYNC_SUB,
  ALERT_EMAIL: "alerts@example.invalid",
  BACKSTOP_LIMIT_USD: "5.0",
};

/** The placeholder OIDC subjects, for tests that assert on trust documents. */
export const PLACEHOLDER_SUBS = {
  deploy: SHELL_VARS.DEPLOY_SUB,
  update: SHELL_VARS.UPDATE_SUB,
  corpusSync: SHELL_VARS.CORPUS_SYNC_SUB,
};

function substituteShellVars(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(SHELL_VARS)) {
    out = out.split(`\${${name}}`).join(value);
  }
  return out;
}

export type TerraformRole = {
  /** Terraform resource label, e.g. `server_exec`. */
  ref: string;
  /** The real IAM role name, e.g. `bbb-mcp-server-exec`. */
  name: string;
  /** The `local.*` reference the role's permissions_boundary points at. */
  boundaryLocal: string | null;
  file: string;
};

export type TerraformRolePolicy = {
  ref: string;
  name: string;
  /** Terraform label of the role it attaches to, e.g. `server_exec`. */
  roleRef: string;
  document: HclValue;
  file: string;
};

function tfFiles(): { file: string; text: string }[] {
  return readdirSync(INFRA_DIR)
    .filter((f) => f.endsWith(".tf"))
    .sort()
    .map((file) => ({
      file,
      text: readFileSync(join(INFRA_DIR, file), "utf8"),
    }));
}

function blocks(
  text: string,
  type: string,
): { ref: string; body: { [key: string]: HclValue } }[] {
  // Anchored at column zero: `resource` blocks are top level, and this keeps
  // the pattern from matching the same word inside a comment or a string.
  const re = new RegExp(`^resource\\s+"${type}"\\s+"([A-Za-z0-9_-]+)"\\s*`, "gm");
  const out: { ref: string; body: { [key: string]: HclValue } }[] = [];
  for (const m of text.matchAll(re)) {
    const reader = new HclReader(text, m.index + m[0].length);
    out.push({ ref: m[1], body: reader.parseObject() });
  }
  return out;
}

/**
 * Terraform labels of every resource of a type, from a raw scan rather than
 * the parser. Used to prove nothing IAM-shaped exists that the guard does not
 * model: a managed policy attached with aws_iam_role_policy_attachment grants
 * a role permissions just as an inline policy does, and would otherwise be
 * invisible here.
 */
export function resourceLabels(type: string): string[] {
  const re = new RegExp(`^resource\\s+"${type}"\\s+"([A-Za-z0-9_-]+)"`, "gm");
  return tfFiles()
    .flatMap(({ text }) => [...text.matchAll(re)].map((m) => m[1]))
    .sort();
}

/**
 * How many `permissions_boundary` attributes appear across infra/*.tf. An
 * independent signal from the resource-block scan, so "every role declares a
 * boundary" is not compared against a count derived the same way.
 */
export function permissionsBoundaryCount(): number {
  return tfFiles().reduce(
    (n, { text }) => n + [...text.matchAll(/^\s*permissions_boundary\s*=/gm)].length,
    0,
  );
}

/** Raw count of a resource type, used as a floor on what the parser found. */
export function countResources(type: string): number {
  const re = new RegExp(`^resource\\s+"${type}"\\s+"`, "gm");
  return tfFiles().reduce(
    (n, { text }) => n + [...text.matchAll(re)].length,
    0,
  );
}

function expectExpression(v: HclValue | undefined, what: string): string {
  if (!(v instanceof HclExpression)) {
    throw new Error(`${what} is not a Terraform expression`);
  }
  return v.source;
}

function expectString(v: HclValue | undefined, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} is not a string literal`);
  return v;
}

export function terraformRoles(): TerraformRole[] {
  const out: TerraformRole[] = [];
  for (const { file, text } of tfFiles()) {
    for (const { ref, body } of blocks(text, "aws_iam_role")) {
      const boundary = body.permissions_boundary;
      out.push({
        ref,
        name: expectString(body.name, `aws_iam_role.${ref}.name`),
        boundaryLocal:
          boundary === undefined
            ? null
            : expectExpression(
                boundary,
                `aws_iam_role.${ref}.permissions_boundary`,
              ),
        file,
      });
    }
  }
  return out;
}

export function terraformRolePolicies(): TerraformRolePolicy[] {
  const out: TerraformRolePolicy[] = [];
  for (const { file, text } of tfFiles()) {
    for (const { ref, body } of blocks(text, "aws_iam_role_policy")) {
      const roleExpr = expectExpression(
        body.role,
        `aws_iam_role_policy.${ref}.role`,
      );
      // `aws_iam_role.server_exec.id`
      const m = /^aws_iam_role\.([A-Za-z0-9_-]+)\./.exec(roleExpr);
      if (!m) {
        throw new Error(
          `aws_iam_role_policy.${ref}.role does not reference an aws_iam_role: ${roleExpr}`,
        );
      }
      out.push({
        ref,
        name: expectString(body.name, `aws_iam_role_policy.${ref}.name`),
        roleRef: m[1],
        document: unwrapJsonencode(
          body.policy,
          `aws_iam_role_policy.${ref}.policy`,
        ),
        file,
      });
    }
  }
  return out;
}

function unwrapJsonencode(v: HclValue | undefined, what: string): HclValue {
  const source = expectExpression(v, what);
  if (!source.startsWith("jsonencode(") || !source.endsWith(")")) {
    throw new Error(`${what} is not a jsonencode(...) call: ${source}`);
  }
  const inner = source.slice("jsonencode(".length, -1);
  return new HclReader(inner).parseValue();
}

/** Maps `boundary_workload` -> the IAM policy name its ARN ends in. */
export function boundaryLocals(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { text } of tfFiles()) {
    const re = /^\s*(boundary_[A-Za-z0-9_]+)\s*=\s*"([^"]*)"/gm;
    for (const m of text.matchAll(re)) {
      const arn = m[2];
      const slash = arn.lastIndexOf(":policy/");
      if (slash === -1) {
        throw new Error(`local.${m[1]} is not a policy ARN: ${arn}`);
      }
      out[m[1]] = arn.slice(slash + ":policy/".length);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// infra/BOOTSTRAP.md

export const BOOTSTRAP_PATH = join(INFRA_DIR, "BOOTSTRAP.md");

function bootstrapText(): string {
  return readFileSync(BOOTSTRAP_PATH, "utf8");
}

/**
 * Pulls a `cat > <path> <<EOF ... EOF` heredoc out of the bootstrap script
 * and parses it as JSON, substituting the shell variables it interpolates.
 */
export function bootstrapJson(path: string): HclValue {
  const text = bootstrapText();
  const marker = `cat > ${path} <<EOF\n`;
  // Exactly one, not the first one. A second heredoc to the same path silently
  // overwrites the first when the script runs, so a reader that took the first
  // would validate a document the account never sees.
  const occurrences = text.split(marker).length - 1;
  if (occurrences === 0) {
    throw new Error(`infra/BOOTSTRAP.md no longer writes ${path}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `infra/BOOTSTRAP.md writes ${path} ${occurrences} times; the last write ` +
        `is what the account gets, so the guard cannot tell which document is ` +
        `live. Keep one heredoc per path.`,
    );
  }
  const start = text.indexOf(marker);
  const bodyStart = start + marker.length;
  const end = text.indexOf("\nEOF\n", bodyStart);
  if (end === -1) throw new Error(`heredoc for ${path} is unterminated`);

  const body = substituteShellVars(text.slice(bodyStart, end));
  if (body.includes("${")) {
    throw new Error(
      `heredoc for ${path} interpolates a shell variable the guard does not ` +
        "know how to substitute; add it to SHELL_VARS in " +
        "tests/helpers/infra-policies.ts",
    );
  }
  return JSON.parse(body) as HclValue;
}

/** The bootstrap script with backslash-newline continuations collapsed, so
 * multi-line aws CLI calls can be matched as single lines. */
export function bootstrapFlatText(): string {
  return bootstrapText().replace(/\\\n\s*/g, " ");
}

export type BootstrapRole = {
  name: string;
  /** The heredoc path of the trust policy the role is created with. */
  trustPath: string;
  /** The policy name of the permissions boundary it is created with. */
  boundary: string | null;
};

/** `arn:...:policy/<name>` (after shell substitution) -> `<name>`. */
function policyNameOf(arn: string, what: string): string {
  const resolved = substituteShellVars(arn.replace(/^"|"$/g, ""));
  const m = /^arn:aws:iam::\d+:policy\/([A-Za-z0-9_+=,.@-]+)$/.exec(resolved);
  if (!m) throw new Error(`${what} is not a literal policy ARN: ${arn}`);
  return m[1];
}

/**
 * Every role the bootstrap script creates by hand, read from the
 * `aws iam create-role` calls rather than from the policy statements the
 * guard checks against them. Identified by trust document, not by position,
 * so reordering the script cannot swap two roles' identities.
 */
export function bootstrapCreatedRoles(): BootstrapRole[] {
  const flat = bootstrapFlatText();
  const out: BootstrapRole[] = [];
  const re =
    /aws iam create-role\s+--role-name\s+(\S+)\s+--assume-role-policy-document\s+file:\/\/(\S+)([^\n]*)/g;
  for (const m of flat.matchAll(re)) {
    const b = /--permissions-boundary\s+(\S+)/.exec(m[3]);
    out.push({
      name: m[1],
      trustPath: m[2],
      boundary: b ? policyNameOf(b[1], `create-role ${m[1]} boundary`) : null,
    });
  }
  const bare = [...flat.matchAll(/aws iam create-role/g)].length;
  if (bare !== out.length) {
    throw new Error(
      "infra/BOOTSTRAP.md has an `aws iam create-role` call whose shape the " +
        "guard does not understand (expected --role-name then " +
        "--assume-role-policy-document file://<path>)",
    );
  }
  return out;
}

export type BootstrapRolePolicy = {
  role: string;
  policyName: string;
  /** The heredoc path of the policy document attached to the role. */
  docPath: string;
};

/** Every inline policy the bootstrap script attaches with put-role-policy. */
export function bootstrapRolePolicies(): BootstrapRolePolicy[] {
  const flat = bootstrapFlatText();
  const out: BootstrapRolePolicy[] = [];
  const re =
    /aws iam put-role-policy\s+--role-name\s+(\S+)\s+--policy-name\s+(\S+)\s+--policy-document\s+file:\/\/(\S+)/g;
  for (const m of flat.matchAll(re)) {
    out.push({ role: m[1], policyName: m[2], docPath: m[3] });
  }
  const bare = [...flat.matchAll(/aws iam put-role-policy/g)].length;
  if (bare !== out.length) {
    throw new Error(
      "infra/BOOTSTRAP.md has an `aws iam put-role-policy` call whose shape " +
        "the guard does not understand",
    );
  }
  return out;
}

/**
 * The one hand-created role whose trust policy is the given heredoc. The
 * deploy role is the one created with /tmp/trust.json, the update role the
 * one created with /tmp/update-trust.json.
 */
export function bootstrapRoleByTrust(trustPath: string): string {
  const matches = bootstrapCreatedRoles().filter(
    (r) => r.trustPath === trustPath,
  );
  if (matches.length !== 1) {
    throw new Error(
      `infra/BOOTSTRAP.md creates ${matches.length} roles with the trust ` +
        `policy ${trustPath}; the guard needs exactly one to know which ` +
        "role its checks are about",
    );
  }
  return matches[0].name;
}

/** The deploy role's name (the role created with /tmp/trust.json). */
export function bootstrapDeployRoleName(): string {
  return bootstrapRoleByTrust("/tmp/trust.json");
}

/**
 * Every `aws iam put-role-permissions-boundary` call, as role -> boundary
 * policy name. The script re-applies each hand-made role's boundary on a
 * re-run, so this must agree with the create-role call.
 */
export function bootstrapBoundaryRefreshes(): { role: string; boundary: string }[] {
  const flat = bootstrapFlatText();
  const re =
    /aws iam put-role-permissions-boundary\s+--role-name\s+(\S+)\s+--permissions-boundary\s+(\S+)/g;
  const out = [...flat.matchAll(re)].map((m) => ({
    role: m[1],
    boundary: policyNameOf(m[2], `put-role-permissions-boundary ${m[1]}`),
  }));
  const bare = [...flat.matchAll(/aws iam put-role-permissions-boundary/g)].length;
  if (bare !== out.length) {
    throw new Error(
      "infra/BOOTSTRAP.md has an `aws iam put-role-permissions-boundary` " +
        "call whose shape the guard does not understand",
    );
  }
  return out;
}

/**
 * Every right-hand side assigned to a shell variable at the start of a line
 * (indented or not), raw and unexpanded, in file order. Used to pin how the
 * OIDC subjects are derived and which values the script's switches default
 * to.
 */
export function bootstrapShellAssignments(name: string): string[] {
  const re = new RegExp(`^[ \\t]*${name}=(.*)$`, "gm");
  return [...bootstrapText().matchAll(re)].map((m) =>
    m[1].replace(/\s+#.*$/, "").trim(),
  );
}

/** Every flattened `aws <service> <command> ...` invocation, one per entry. */
export function bootstrapCommands(command: string): string[] {
  const re = new RegExp(`aws ${command}\\b[^\\n]*`, "g");
  return [...bootstrapFlatText().matchAll(re)].map((m) =>
    substituteShellVars(m[0]),
  );
}

/** The `put_managed_policy <name> <doc-path>` calls, in file order. */
export function bootstrapManagedPolicyCalls(): { name: string; path: string }[] {
  const re = /^[ \t]*put_managed_policy\s+(\S+)\s+(\S+)/gm;
  return [...bootstrapText().matchAll(re)].map((m) => ({
    name: m[1],
    path: m[2],
  }));
}

/**
 * The permissions-boundary policies among them. Named by prefix; the test
 * file pins the full list of managed policies separately, so a boundary
 * cannot hide under another name.
 */
export function bootstrapBoundaryCalls(): { name: string; path: string }[] {
  return bootstrapManagedPolicyCalls().filter((c) =>
    c.name.startsWith("bbb-mcp-boundary-"),
  );
}

/**
 * The two branches of section 3b's DEPLOY_ROLE_STAGE switch, as raw script
 * text. The transition branch is Paste A of "Update for auto-deploy", which
 * must not apply the narrowed deploy policy.
 */
export function bootstrapDeployStageBranches(): {
  transition: string;
  final: string;
} {
  const text = bootstrapText();
  const tOpen = 'if [ "${DEPLOY_ROLE_STAGE}" = "transition" ]; then\n';
  const fOpen = 'elif [ "${DEPLOY_ROLE_STAGE}" = "final" ]; then\n';
  const close = "\nelse\n";
  const count = (marker: string) => text.split(marker).length - 1;
  if (count(tOpen) !== 1 || count(fOpen) !== 1) {
    throw new Error(
      "infra/BOOTSTRAP.md section 3b no longer has exactly one " +
        "DEPLOY_ROLE_STAGE transition/final switch",
    );
  }
  const t = text.indexOf(tOpen) + tOpen.length;
  const f = text.indexOf(fOpen);
  const e = text.indexOf(close, f);
  if (!(t < f && f < e)) {
    throw new Error("the DEPLOY_ROLE_STAGE switch is out of order");
  }
  return {
    transition: text.slice(t, f),
    final: text.slice(f + fOpen.length, e),
  };
}

// ---------------------------------------------------------------------------
// infra/*.tf: the backstop handover and the model ARNs

/** Every top-level `removed { from = X lifecycle { destroy = false } }`. */
export function removedBlocks(): { from: string; destroy: boolean }[] {
  const out: { from: string; destroy: boolean }[] = [];
  for (const { text } of tfFiles()) {
    const starts = [...text.matchAll(/^removed\s*\{/gm)];
    const re =
      /^removed\s*\{\s*from\s*=\s*([A-Za-z0-9_.-]+)\s*lifecycle\s*\{\s*destroy\s*=\s*(true|false)\s*\}\s*\}/gm;
    const parsed = [...text.matchAll(re)];
    if (parsed.length !== starts.length) {
      throw new Error(
        "infra/*.tf has a `removed` block whose shape the guard does not " +
          "understand (expected only `from` and `lifecycle { destroy }`)",
      );
    }
    for (const m of parsed) out.push({ from: m[1], destroy: m[2] === "true" });
  }
  return out;
}

/**
 * The Bedrock model ARNs infra/rag.tf grants on, evaluated from its locals
 * with the same placeholder account and the default region the bootstrap
 * stand-ins use: titan_embed_arn, rag_profile_arn, rag_model_region_arns.
 */
export function ragModelArns(): string[] {
  const text = readFileSync(join(INFRA_DIR, "rag.tf"), "utf8");
  const one = (name: string): string => {
    const all = [...text.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "gm"))];
    if (all.length !== 1) {
      throw new Error(`infra/rag.tf defines local.${name} ${all.length} times`);
    }
    return all[0][1];
  };
  const list = /^\s*rag_model_region_arns\s*=\s*\[([^\]]*)\]/m.exec(text);
  if (!list) throw new Error("infra/rag.tf has no rag_model_region_arns list");
  const regionArns = [...list[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);

  const haiku = one("haiku_model_id");
  const evaluate = (raw: string): string => {
    const out = raw
      .split("${var.aws_region}").join(PLACEHOLDER_REGION)
      .split("${local.account_id}").join(PLACEHOLDER_ACCOUNT_ID)
      .split("${local.haiku_model_id}").join(haiku);
    if (out.includes("${")) {
      throw new Error(`cannot evaluate infra/rag.tf expression ${raw}`);
    }
    return out;
  };
  return [one("titan_embed_arn"), one("rag_profile_arn"), ...regionArns].map(
    evaluate,
  );
}
