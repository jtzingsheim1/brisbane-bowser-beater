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

const SHELL_VARS: Record<string, string> = {
  REGION: "ap-southeast-2",
  ACCOUNT_ID: PLACEHOLDER_ACCOUNT_ID,
  STATE_BUCKET: `bbb-mcp-tfstate-${PLACEHOLDER_ACCOUNT_ID}`,
};

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

  let body = text.slice(bodyStart, end);
  for (const [name, value] of Object.entries(SHELL_VARS)) {
    body = body.split(`\${${name}}`).join(value);
  }
  if (body.includes("${")) {
    throw new Error(
      `heredoc for ${path} interpolates a shell variable the guard does not ` +
        "know how to substitute; add it to SHELL_VARS in " +
        "tests/helpers/infra-policies.ts",
    );
  }
  return JSON.parse(body) as HclValue;
}

/**
 * The deploy role's name, read from the `aws iam create-role` call rather than
 * from the policy statements the guard checks against it.
 */
export function bootstrapDeployRoleName(): string {
  const m = /^\s*aws iam create-role --role-name (\S+)/m.exec(bootstrapText());
  if (!m) {
    throw new Error(
      "infra/BOOTSTRAP.md no longer creates the deploy role with " +
        "`aws iam create-role --role-name <name>`",
    );
  }
  return m[1];
}

/** The `put_boundary <name> <doc-path>` calls, in file order. */
export function bootstrapBoundaryCalls(): { name: string; path: string }[] {
  const re = /^put_boundary\s+(\S+)\s+(\S+)/gm;
  return [...bootstrapText().matchAll(re)].map((m) => ({
    name: m[1],
    path: m[2],
  }));
}
