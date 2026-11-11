import { describe, expect, it } from "vitest";
import {
  allowedActions,
  matchesGlob,
  statementsOf,
  stringList,
  type HclValue,
  type PolicyStatement,
} from "./helpers/hcl-policy";
import {
  boundaryLocals,
  bootstrapBoundaryCalls,
  bootstrapBoundaryRefreshes,
  bootstrapCommands,
  bootstrapCreatedRoles,
  bootstrapDeployRoleName,
  bootstrapDeployStageBranches,
  bootstrapFlatText,
  bootstrapJson,
  bootstrapManagedPolicyCalls,
  bootstrapRoleByTrust,
  bootstrapRolePolicies,
  bootstrapShellAssignments,
  countResources,
  permissionsBoundaryCount,
  PLACEHOLDER_ACCOUNT_ID,
  PLACEHOLDER_REGION,
  PLACEHOLDER_SUBS,
  ragModelArns,
  removedBlocks,
  resourceLabels,
  SUBJECT_TAILS,
  terraformRolePolicies,
  terraformRoles,
} from "./helpers/infra-policies";

// Permissions boundary drift guard (issue #101), and the IAM shape of the
// two-role MCP deploy (an unattended update role plus a reviewer-gated deploy
// role) with its human-owned cost backstop.
//
// The two IAM permissions boundaries that cap every role the MCP stack
// creates live in infra/BOOTSTRAP.md, as a script a human pastes into
// CloudShell. The roles they cap, and the policies attached to those roles,
// live in infra/*.tf and are written by an automated deploy -- except the
// cost backstop's action role, which the bootstrap itself creates under the
// IAM boundary. That split is deliberate: the deploy role can version
// bbb-mcp-* policies, so a Terraform-managed boundary could be widened by the
// very thing it exists to constrain.
//
// The cost of the split is that the artifacts can drift, silently, in both
// directions:
//
//   * A role policy grows past its boundary. Effective permissions are the
//     INTERSECTION of the two, so the new capability is simply dead. It fails
//     as an AccessDenied at runtime, not at apply time, in a stack nobody
//     exercises by hand.
//
//   * A boundary grows past its roles. Nothing breaks, so nothing complains,
//     and the ceiling quietly stops being a ceiling. That is exactly how the
//     first cut of this design went wrong: a single union boundary handed the
//     server role an IAM ceiling only the budget-action role needed, which
//     would have let a rewritten server policy detach the backstop's deny
//     policy.
//
// So the invariant asserted here is equality, not containment: each boundary
// allows exactly the actions the roles it caps actually use.
//
// The second half of the file pins the roles GitHub Actions assumes: what
// the unattended update role may do (exactly), that neither it nor the gated
// deploy role can touch the backstop, which OIDC subject each trusts, and
// that the migration paste (Paste A) cannot apply the narrowed deploy policy
// early.
//
// SCOPE, stated plainly so nobody reads more assurance into a green run than
// it earns:
//
//   * Boundary parity compares ACTIONS only. Resource scoping and conditions
//     are compared only where a test below says so (the workload boundary's
//     model ARNs, the backstop's target roles, the update role's grants).
//   * Boundary parity is per boundary, against the UNION of the roles it
//     caps. `bbb-mcp-boundary-workload` caps two roles, so the union is the
//     only thing that can equal it. Cross-contamination between those two
//     (the knowledge-base role taking an action only the server needs) is
//     caught instead by EXPECTED_ROLE_ACTIONS below, which pins each role's
//     grants individually.
//   * Everything is read from the committed files. This proves the artifacts
//     agree with each other, not that any of them matches the live AWS
//     account.
//   * These tests catch mistakes. They are not controls: anyone who can put
//     code on main can change them too. IAM, role trust and AWS quotas are
//     the controls.

const ROLE_COUNT = 2;
const ROLE_POLICY_COUNT = 3;
const BOUNDARY_COUNT = 2;

// Hand-made roles (infra/BOOTSTRAP.md), by the trust document each is
// created with. Identity comes from the trust path, so a reorder or a rename
// in the script cannot swap two roles' checks.
const HAND_MADE_ROLES: Record<string, string> = {
  "bbb-mcp-deploy": "/tmp/trust.json",
  "bbb-mcp-update": "/tmp/update-trust.json",
  "bbb-mcp-corpus-sync": "/tmp/corpus-trust.json",
  "bbb-backstop-action": "/tmp/backstop-action-trust.json",
};
const HAND_MADE_POLICIES: Record<string, string> = {
  "bbb-mcp-deploy": "/tmp/policy.json",
  "bbb-mcp-update": "/tmp/update-policy.json",
  "bbb-mcp-corpus-sync": "/tmp/corpus-policy.json",
  "bbb-backstop-action": "/tmp/backstop-action-policy.json",
};
const CORPUS_SYNC_ROLE = "bbb-mcp-corpus-sync";
const BACKSTOP_ROLE = "bbb-backstop-action";
const BACKSTOP_DENY = "bbb-backstop-deny";
const BACKSTOP_BUDGET = "bbb-backstop-monthly";
const IAM_BOUNDARY = "bbb-mcp-boundary-iam";
const WORKLOAD_BOUNDARY = "bbb-mcp-boundary-workload";

// Every IAM resource type in infra/*.tf that can grant a role permissions,
// with the labels allowed to exist. A managed policy attached via
// aws_iam_role_policy_attachment grants a role exactly as an inline policy
// does, and this guard reads only inline policies -- so rather than model the
// other route, assert it does not appear. No managed policy is left in the
// stack: the backstop's deny policy is human-owned (BOOTSTRAP section 3d).
const ALLOWED_IAM_RESOURCES: Record<string, string[]> = {
  aws_iam_policy: [],
  aws_iam_role_policy_attachment: [],
  aws_iam_user_policy: [],
  aws_iam_user_policy_attachment: [],
  aws_iam_group_policy: [],
  aws_iam_group_policy_attachment: [],
};

// Exactly what each capped role may be granted, pinned so an IAM change
// cannot land without a reviewed diff here. This is the per-role complement
// to the per-boundary parity below: the union of these must equal the
// boundaries, and each individual set must equal this table. The first two
// are Terraform roles; the backstop role is created by the bootstrap.
const EXPECTED_ROLE_ACTIONS: Record<string, string[]> = {
  "bbb-mcp-server-exec": [
    "bedrock:GetInferenceProfile",
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:Retrieve",
    "bedrock:RetrieveAndGenerate",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ],
  "bbb-mcp-kb-role": [
    "bedrock:InvokeModel",
    "s3:GetObject",
    "s3:ListBucket",
    "s3vectors:DeleteVectors",
    "s3vectors:GetIndex",
    "s3vectors:GetVectorBucket",
    "s3vectors:GetVectors",
    "s3vectors:ListIndexes",
    "s3vectors:ListVectors",
    "s3vectors:PutVectors",
    "s3vectors:QueryVectors",
  ],
  [BACKSTOP_ROLE]: [
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
    "iam:GetRole",
    "iam:ListAttachedRolePolicies",
  ],
};

// Actions a boundary may allow that no role policy uses yet. Empty by design.
// Adding an entry is a deliberate decision that shows up in a diff, which is
// the point: a boundary wider than its roles is drift unless someone says
// otherwise in writing.
const BOUNDARY_ONLY_ACTIONS: Record<string, string[]> = {};

// Every read below happens at module scope, so an unparseable file would
// otherwise abort collection and report as a suite error rather than as a
// named failing test. Errors are collected instead and asserted in the first
// test, and the fallbacks are empty so nothing downstream can go green on
// missing data.
const readErrors: string[] = [];
function safely<T>(what: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    readErrors.push(
      `${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback;
  }
}

const roles = safely("infra/*.tf IAM roles", terraformRoles, []);
const rolePolicies = safely(
  "infra/*.tf IAM role policies",
  terraformRolePolicies,
  [],
);
const locals = safely<Record<string, string>>(
  "infra/*.tf boundary locals",
  boundaryLocals,
  {},
);
const boundaryCalls = safely(
  "infra/BOOTSTRAP.md boundary policies",
  bootstrapBoundaryCalls,
  [],
);
const managedPolicyCalls = safely(
  "infra/BOOTSTRAP.md put_managed_policy calls",
  bootstrapManagedPolicyCalls,
  [],
);
const deployRoleName = safely(
  "infra/BOOTSTRAP.md deploy role name",
  bootstrapDeployRoleName,
  "",
);
const updateRoleName = safely(
  "infra/BOOTSTRAP.md update role name",
  () => bootstrapRoleByTrust("/tmp/update-trust.json"),
  "",
);
const createdRoles = safely(
  "infra/BOOTSTRAP.md create-role calls",
  bootstrapCreatedRoles,
  [],
);
const bootstrapPolicies = safely(
  "infra/BOOTSTRAP.md put-role-policy calls",
  bootstrapRolePolicies,
  [],
);
const boundaryRefreshes = safely(
  "infra/BOOTSTRAP.md put-role-permissions-boundary calls",
  bootstrapBoundaryRefreshes,
  [],
);
const modelArns = safely("infra/rag.tf model ARNs", ragModelArns, []);
const removed = safely("infra/*.tf removed blocks", removedBlocks, []);

const A = PLACEHOLDER_ACCOUNT_ID;
const R = PLACEHOLDER_REGION;
const roleArn = (name: string) => `arn:aws:iam::${A}:role/${name}`;
const policyArn = (name: string) => `arn:aws:iam::${A}:policy/${name}`;
const budgetArn = (name: string) => `arn:aws:budgets::${A}:budget/${name}`;

/** Reads a bootstrap heredoc, recording a failure instead of throwing. */
function doc(path: string): HclValue | null {
  return safely<HclValue | null>(`infra/BOOTSTRAP.md ${path}`, () => bootstrapJson(path), null);
}
function statementsIn(path: string): PolicyStatement[] {
  const d = doc(path);
  return d === null
    ? []
    : safely(`statements of ${path}`, () => statementsOf(d, path), []);
}

/** Boundary policy name -> its parsed document. */
const boundaryDocs = new Map<string, HclValue>(
  boundaryCalls
    .map(({ name, path }) => [name, doc(path)])
    .filter((entry): entry is [string, HclValue] => entry[1] !== null),
);

/** Boundary policy name -> the actions its document allows. */
const boundaryActions = new Map<string, Set<string>>(
  [...boundaryDocs].map(([name, d]) => [
    name,
    safely(`boundary document ${name}`, () => allowedActions(d, name).actions, new Set<string>()),
  ]),
);

/** Terraform role label -> the actions its inline policies allow. */
function actionsByTerraformRole(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const policy of rolePolicies) {
    const { actions } = allowedActions(policy.document, policy.ref);
    const set = out.get(policy.roleRef) ?? new Set<string>();
    for (const a of actions) set.add(a);
    out.set(policy.roleRef, set);
  }
  return out;
}

const boundaryOfLocal = (local: string | null) =>
  locals[(local ?? "").replace(/^local\./, "")] as string | undefined;

/**
 * Every role that carries a permissions boundary, from either source: the
 * Terraform roles (boundary via a local) and the hand-made roles the
 * bootstrap creates with --permissions-boundary. Boundary parity is computed
 * over this list, so the backstop role created in BOOTSTRAP section 3d is
 * held to bbb-mcp-boundary-iam exactly as a Terraform role would be.
 */
type CappedRole = {
  name: string;
  boundary: string | undefined;
  actions: Set<string>;
  where: string;
};
const cappedRoles: CappedRole[] = safely(
  "capped roles",
  () => {
    const byRef = actionsByTerraformRole();
    const fromTf: CappedRole[] = roles.map((r) => ({
      name: r.name,
      boundary: boundaryOfLocal(r.boundaryLocal),
      actions: byRef.get(r.ref) ?? new Set<string>(),
      where: `infra/${r.file}`,
    }));
    const fromBootstrap: CappedRole[] = createdRoles
      .filter((r) => r.boundary !== null)
      .map((r) => {
        const attached = bootstrapPolicies.filter((p) => p.role === r.name);
        const actions = new Set<string>();
        for (const p of attached) {
          for (const a of allowedActions(bootstrapJson(p.docPath), p.docPath).actions) {
            actions.add(a);
          }
        }
        return {
          name: r.name,
          boundary: r.boundary ?? undefined,
          actions,
          where: "infra/BOOTSTRAP.md",
        };
      });
    return [...fromTf, ...fromBootstrap];
  },
  [],
);

/** Boundary policy name -> the roles capped with it. */
function rolesByBoundary(): Map<string, CappedRole[]> {
  const out = new Map<string, CappedRole[]>();
  for (const role of cappedRoles) {
    if (!role.boundary) continue; // asserted separately below
    const list = out.get(role.boundary) ?? [];
    list.push(role);
    out.set(role.boundary, list);
  }
  return out;
}

const sorted = (s: Iterable<string>) => [...s].sort();

describe("infra parses completely", () => {
  // Every assertion below reduces to a set comparison, and an empty set is a
  // subset of anything. These keep a reader that quietly failed to find the
  // roles, the policies or the boundaries from turning this whole file into a
  // green no-op.
  it("reads every artifact it compares", () => {
    expect(
      readErrors,
      `the guard could not read one of the files it compares, so every ` +
        `assertion below would be working from empty data`,
    ).toEqual([]);
    expect(deployStatements.length).toBeGreaterThan(0);
    expect(updateStatements.length).toBeGreaterThan(0);
    expect(modelArns.length).toBe(4);
  });

  it("finds the expected number of IAM blocks in infra/*.tf", () => {
    // The literals are the independent signal: the raw scan and the parser
    // share a pattern, so comparing them to each other would be a tautology.
    // countResources is still a floor -- the parser cannot report more blocks
    // than the file contains.
    expect(roles.length).toBeLessThanOrEqual(countResources("aws_iam_role"));
    expect(rolePolicies.length).toBeLessThanOrEqual(
      countResources("aws_iam_role_policy"),
    );
    expect(roles).toHaveLength(ROLE_COUNT);
    expect(rolePolicies).toHaveLength(ROLE_POLICY_COUNT);
  });

  it("finds both boundary documents in the bootstrap script", () => {
    expect(boundaryCalls).toHaveLength(BOUNDARY_COUNT);
    expect(boundaryActions.size).toBe(BOUNDARY_COUNT);
    for (const [name, actions] of boundaryActions) {
      expect(actions.size, `${name} allows no actions`).toBeGreaterThan(0);
    }
  });

  it("attributes every role policy to a role that exists", () => {
    const refs = new Set(roles.map((r) => r.ref));
    for (const policy of rolePolicies) {
      expect(refs, `${policy.ref} in infra/${policy.file}`).toContain(
        policy.roleRef,
      );
    }
  });

  it("reads at least one Allow action out of every role policy", () => {
    for (const policy of rolePolicies) {
      const { actions } = allowedActions(policy.document, policy.ref);
      expect(actions.size, `${policy.ref} allows no actions`).toBeGreaterThan(0);
    }
  });

  it("finds no IAM grant route it does not model", () => {
    // An aws_iam_role_policy_attachment would grant a role permissions that
    // no assertion in this file ever sees.
    for (const [type, allowed] of Object.entries(ALLOWED_IAM_RESOURCES)) {
      expect(
        resourceLabels(type),
        `infra/*.tf declares an unexpected ${type}. This guard reads inline ` +
          `aws_iam_role_policy blocks only, so a grant made this way is ` +
          `invisible to every check here. Model it, or do not use it.`,
      ).toEqual(allowed.slice().sort());
    }
  });
});

describe("every role Terraform creates is capped", () => {
  it("declares a permissions_boundary", () => {
    for (const role of roles) {
      expect(
        role.boundaryLocal,
        `aws_iam_role.${role.ref} (${role.name}) in infra/${role.file} has no ` +
          `permissions_boundary. Every role this stack creates needs one, ` +
          `because the deploy role can rewrite its policy.`,
      ).not.toBeNull();
    }
    // Counted from the raw text, independently of how the roles were parsed.
    expect(permissionsBoundaryCount()).toBe(roles.length);
  });

  it("points that boundary at a policy the bootstrap actually creates", () => {
    const created = new Set(boundaryCalls.map((c) => c.name));
    for (const role of roles) {
      const name = boundaryOfLocal(role.boundaryLocal);
      expect(name, `${role.boundaryLocal} is not a boundary ARN in infra/*.tf`).toBeDefined();
      expect(
        created,
        `aws_iam_role.${role.ref} is capped with ${name}, which ` +
          `infra/BOOTSTRAP.md never creates`,
      ).toContain(name);
    }
  });

  it("declares no boundary local that no role uses", () => {
    // bbb-mcp-boundary-iam caps only the hand-made backstop role, so a
    // Terraform local for it would be dead -- or the first step of putting a
    // Terraform role under the IAM ceiling.
    const used = new Set(roles.map((r) => (r.boundaryLocal ?? "").replace(/^local\./, "")));
    expect(sorted(Object.keys(locals).filter((k) => !used.has(k)))).toEqual([]);
    expect(Object.values(locals)).not.toContain(IAM_BOUNDARY);
  });

  it("uses both boundaries (an unused one is a boundary nobody is testing)", () => {
    expect(sorted(rolesByBoundary().keys())).toEqual(
      sorted(boundaryCalls.map((c) => c.name)),
    );
  });
});

describe("each capped role is granted exactly what it is meant to be granted", () => {
  for (const role of cappedRoles) {
    it(`${role.name} (${role.where})`, () => {
      const expected = EXPECTED_ROLE_ACTIONS[role.name];
      expect(
        expected,
        `${role.name} has no entry in EXPECTED_ROLE_ACTIONS. A new role's ` +
          `grants must be written down here to be reviewable.`,
      ).toBeDefined();
      expect(
        sorted(role.actions),
        `the policies for ${role.name} grant a different action set ` +
          `than EXPECTED_ROLE_ACTIONS records. If the change is intended, ` +
          `update the table in this file; that diff is the review.`,
      ).toEqual(sorted(expected ?? []));
    });
  }

  it("covers every capped role and nothing else", () => {
    expect(sorted(Object.keys(EXPECTED_ROLE_ACTIONS))).toEqual(
      sorted(cappedRoles.map((r) => r.name)),
    );
  });
});

describe("each boundary allows exactly what its roles use", () => {
  const byBoundary = rolesByBoundary();

  for (const [boundary, actions] of boundaryActions) {
    const capped = byBoundary.get(boundary) ?? [];
    const used = new Set<string>();
    for (const role of capped) {
      for (const a of role.actions) used.add(a);
    }
    const allowedExtra = new Set(BOUNDARY_ONLY_ACTIONS[boundary] ?? []);

    it(`${boundary} covers every action ${capped
      .map((r) => r.name)
      .join(" + ")} grants`, () => {
      // Uncovered actions are dead on arrival: effective permissions are the
      // intersection, so this surfaces as an AccessDenied in production.
      const uncovered = sorted(used).filter((a) => !actions.has(a));
      expect(
        uncovered,
        `these actions are granted to roles capped by ${boundary} but not ` +
          `permitted by it in infra/BOOTSTRAP.md, so they cannot take ` +
          `effect. Widen the boundary in the bootstrap script (section 3a) ` +
          `and re-run the paste.`,
      ).toEqual([]);
    });

    it(`${boundary} allows nothing beyond what those roles use`, () => {
      const unused = sorted(actions).filter(
        (a) => !used.has(a) && !allowedExtra.has(a),
      );
      expect(
        unused,
        `${boundary} in infra/BOOTSTRAP.md permits actions no role it caps ` +
          `uses, so the ceiling is wider than the stack needs. Either drop ` +
          `them from the boundary, or record them in BOUNDARY_ONLY_ACTIONS ` +
          `in this file with a reason.`,
      ).toEqual([]);
    });

    it(`${boundary} narrows nothing with a Deny`, () => {
      // A boundary is read here as a set of Allows. A Deny inside one would
      // narrow the real ceiling below what the parity checks above compare,
      // so an action could look covered and still fail at runtime.
      const denies = statementsOf(boundaryDocs.get(boundary) as HclValue, boundary)
        .filter((st) => st.effect === "Deny")
        .map((st) => st.sid ?? "(no Sid)");
      expect(
        denies,
        `${boundary} contains Deny statements. This guard compares Allow ` +
          `actions only, so a Deny here would shrink the effective ceiling ` +
          `invisibly. Express the limit by omitting the action instead.`,
      ).toEqual([]);
    });
  }
});

describe("action sets stay literally comparable", () => {
  // A wildcard would make the two directions above incomparable: `bedrock:*`
  // in a boundary would silently satisfy any bedrock action a role policy ever
  // grows, which is the drift this file exists to catch. Neither artifact uses
  // one today. If one ever needs to, this failing is the prompt to decide how
  // the comparison should handle it rather than losing the guard quietly.
  it("no boundary action is a wildcard", () => {
    for (const [name, actions] of boundaryActions) {
      expect(sorted(actions).filter((a) => a.includes("*")), name).toEqual([]);
    }
  });

  it("no capped role's action is a wildcard", () => {
    for (const role of cappedRoles) {
      expect(
        sorted(role.actions).filter((a) => a.includes("*")),
        role.name,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The workload boundary is also the model scope: a rewritten server policy,
// or stolen server-role credentials, can call only the two models the stack
// uses. Getting these ARNs wrong breaks ask_docs (or ingestion) the moment
// the boundary is pasted, so they are compared EXACTLY with the locals the
// Terraform policies are built from.

const MODEL_ACTIONS = [
  "bedrock:GetInferenceProfile",
  "bedrock:InvokeModel",
  "bedrock:InvokeModelWithResponseStream",
];

describe("the workload boundary limits model calls to the stack's two models", () => {
  const statements = (() => {
    const d = boundaryDocs.get(WORKLOAD_BOUNDARY);
    return d === undefined ? [] : statementsOf(d, WORKLOAD_BOUNDARY);
  })();

  for (const action of MODEL_ACTIONS) {
    it(`${action} is allowed on exactly infra/rag.tf's model ARNs`, () => {
      const resources = statements
        .filter((st) => st.effect === "Allow" && st.actions.includes(action))
        .flatMap((st) => resourcesOf(st));
      expect(
        sorted(resources),
        `the workload boundary's ${action} resources differ from ` +
          `titan_embed_arn + rag_profile_arn + rag_model_region_arns in ` +
          `infra/rag.tf. A model change needs both edited, and section 3a ` +
          `re-pasted before the deploy.`,
      ).toEqual(sorted(modelArns));
    });
  }

  it("keeps only the non-scopeable retrieval calls on Resource \"*\"", () => {
    const onStar = statements
      .filter((st) => resourcesOf(st).includes("*"))
      .flatMap((st) => st.actions);
    expect(sorted(onStar)).toEqual([
      "bedrock:Retrieve",
      "bedrock:RetrieveAndGenerate",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The deploy role's own policy is what makes the boundaries stick: it may only
// create these roles WITH the workload boundary attached, may not create any
// role under the IAM ceiling, may not edit or remove either boundary, and may
// not rewrite itself. Those clauses and the Terraform they constrain are in
// two different files, so they can drift too.
//
// Everything below matches wildcards properly (`iam:*` counts as granting
// `iam:CreateRole`; a Deny on `policy/bbb-mcp-boundary-*` counts as covering a
// specific boundary), because the deploy policy already uses wildcard actions
// and wildcard resources as a matter of house style.

const deployStatements = statementsIn("/tmp/policy.json");
const updateStatements = statementsIn("/tmp/update-policy.json");

function resourcesOf(st: PolicyStatement): string[] {
  const raw = (st.raw as { Resource?: HclValue }).Resource;
  if (raw === undefined) throw new Error(`${st.sid ?? "?"} has no Resource`);
  return stringList(raw, `${st.sid ?? "?"} Resource`);
}

/** A plain object (a JSON or HCL map), else null. HclExpression is not one. */
function asObject(v: HclValue | undefined): Record<string, HclValue> | null {
  if (v === undefined || typeof v !== "object" || Array.isArray(v)) return null;
  if (Object.getPrototypeOf(v) !== Object.prototype) return null;
  return v as Record<string, HclValue>;
}

function boundaryCondition(st: PolicyStatement): string | null {
  const cond = asObject((st.raw as { Condition?: HclValue }).Condition);
  const arnEquals = asObject(cond?.ArnEquals);
  const value = arnEquals?.["iam:PermissionsBoundary"];
  return typeof value === "string" ? value : null;
}

/** Does a statement's Effect apply to this exact (action, resource) pair? */
function covers(st: PolicyStatement, action: string, arn: string): boolean {
  return (
    st.actions.some((a) => matchesGlob(a, action)) &&
    resourcesOf(st).some((r) => matchesGlob(r, arn))
  );
}

const allows = (sts: PolicyStatement[], action: string, arn: string) =>
  sts.some((st) => st.effect === "Allow" && covers(st, action, arn));

/** Allowed action patterns that match an action, whatever the resource. */
const allowedPatternsFor = (sts: PolicyStatement[], action: string) =>
  sts
    .filter((st) => st.effect === "Allow")
    .flatMap((st) => st.actions.filter((a) => matchesGlob(a, action)));

const CAPPING_ACTIONS = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"];

// Actions that let a role's permissions be rewritten. Used to check the deploy
// role cannot turn them on itself, nor on the hand-made roles.
const ROLE_MUTATING_ACTIONS = [
  "iam:AttachRolePolicy",
  "iam:CreateRole",
  "iam:DeleteRole",
  "iam:DeleteRolePermissionsBoundary",
  "iam:DeleteRolePolicy",
  "iam:DetachRolePolicy",
  "iam:PutRolePermissionsBoundary",
  "iam:PutRolePolicy",
  "iam:UpdateAssumeRolePolicy",
  "iam:UpdateRole",
];

/**
 * For one capping action: the Resource patterns pinned to each boundary, plus
 * the Sids of any statement that allows the action without pinning one at all.
 * Collected rather than asserted so an unpinned statement fails as a named
 * test instead of a collection error.
 */
function pinnedPatterns(action: string): {
  byBoundary: Map<string, string[]>;
  unpinned: string[];
} {
  const byBoundary = new Map<string, string[]>();
  const unpinned: string[] = [];
  for (const st of deployStatements) {
    if (st.effect !== "Allow") continue;
    if (!st.actions.some((a) => matchesGlob(a, action))) continue;
    const boundaryArn = boundaryCondition(st);
    if (boundaryArn === null) {
      unpinned.push(`${st.sid ?? "(no Sid)"} allows ${action}`);
      continue;
    }
    const name = boundaryArn.slice(boundaryArn.lastIndexOf("/") + 1);
    const list = byBoundary.get(name) ?? [];
    list.push(...resourcesOf(st));
    byBoundary.set(name, list);
  }
  return { byBoundary, unpinned };
}

describe("the deploy role can only cap these roles the intended way", () => {
  const created = pinnedPatterns("iam:CreateRole").byBoundary;
  const recapped = pinnedPatterns("iam:PutRolePermissionsBoundary").byBoundary;

  it("never allows a role to be created or re-capped without a boundary", () => {
    const unpinned = CAPPING_ACTIONS.flatMap((a) => pinnedPatterns(a).unpinned);
    expect(
      unpinned,
      `these deploy-policy statements allow a capping action without an ` +
        `ArnEquals condition on iam:PermissionsBoundary, so a deploy could ` +
        `create or re-cap a role with no ceiling at all. A wildcard action ` +
        `such as "iam:*" counts as allowing it.`,
    ).toEqual([]);
  });

  it("pins iam:CreateRole to the Terraform roles' boundary only", () => {
    // The IAM ceiling caps only the hand-made backstop role. A deploy that
    // could create a role under it could create one able to detach the
    // backstop's deny policy.
    expect(sorted(created.keys())).toEqual(
      sorted(new Set(roles.map((r) => boundaryOfLocal(r.boundaryLocal) ?? ""))),
    );
    expect(sorted(created.keys())).toEqual([WORKLOAD_BOUNDARY]);
  });

  it("pins re-capping exactly as it pins creation", () => {
    // Otherwise a role could be created under one ceiling and moved to the
    // other afterwards, which is the same escape the split boundary closes.
    const shape = (m: Map<string, string[]>) =>
      sorted(m.keys()).map((k) => [k, sorted(m.get(k) ?? [])]);
    expect(shape(recapped)).toEqual(shape(created));
  });

  it("gives every role exactly one boundary it is eligible for", () => {
    for (const role of roles) {
      const declared = boundaryOfLocal(role.boundaryLocal);
      const eligible = sorted(created.keys()).filter((boundary) =>
        (created.get(boundary) ?? []).some((pattern) =>
          matchesGlob(pattern, roleArn(role.name)),
        ),
      );
      expect(
        eligible,
        `${role.name} must match the role patterns of exactly one boundary. ` +
          `Matching none means the deploy cannot create it; matching more ` +
          `than one means it could be capped with either ceiling.`,
      ).toEqual([declared]);
    }
  });

  it("cannot create a role outside the stack role names", () => {
    // The pinned patterns are the complete list of roles this pipeline can
    // bring into existence. If one widened to cover, say, every role in the
    // account, the ceiling would still be attached but the blast radius of a
    // compromised deploy would not be the roles reviewed here.
    const stackRoleArns = roles.map((r) => roleArn(r.name));
    for (const [boundary, patterns] of created) {
      for (const pattern of patterns) {
        const matched = stackRoleArns.filter((arn) => matchesGlob(pattern, arn));
        expect(
          matched.length,
          `${boundary} is pinned to ${pattern}, which matches no role this ` +
            `stack creates. Either it is dead, or it is a widened pattern ` +
            `(a bare "*", say) that lets the deploy create roles nothing ` +
            `here reviews.`,
        ).toBeGreaterThan(0);
        for (const other of ["bbb-mcp-not-a-stack-role", ...Object.keys(HAND_MADE_ROLES)]) {
          expect(
            matchesGlob(pattern, roleArn(other)),
            `${boundary} is pinned to ${pattern}, which also matches ${other}`,
          ).toBe(false);
        }
      }
    }
  });

  it("denies editing or replacing either boundary policy", () => {
    const required = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
    ];
    for (const boundary of boundaryActions.keys()) {
      const missing = required.filter(
        (action) =>
          !deployStatements.some(
            (st) =>
              st.effect === "Deny" && covers(st, action, policyArn(boundary)),
          ),
      );
      expect(
        missing,
        `the deploy policy must Deny these on ${boundary}; the stack's ` +
          `ManagedPolicies statement otherwise Allows them on bbb-mcp-*, ` +
          `which would let a deploy widen its own ceiling`,
      ).toEqual([]);
    }
  });

  it("denies removing a boundary from any capped role", () => {
    for (const role of cappedRoles) {
      const denied = deployStatements.some(
        (st) =>
          st.effect === "Deny" &&
          covers(st, "iam:DeleteRolePermissionsBoundary", roleArn(role.name)),
      );
      expect(
        denied,
        `the deploy policy must Deny iam:DeleteRolePermissionsBoundary on ` +
          `${role.name}; without it a deploy could simply strip the ceiling ` +
          `off the role`,
      ).toBe(true);
    }
  });

  it("keeps the explicit Deny on its own role", () => {
    // Belt and braces to the net-effect check below: infra/BOOTSTRAP.md
    // states this Deny holds "even if the pattern is ever loosened", so the
    // claim should not be able to quietly stop being true.
    const self = roleArn(deployRoleName);
    const uncovered = [
      "iam:AttachRolePolicy",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ].filter(
      (action) =>
        !deployStatements.some(
          (st) => st.effect === "Deny" && covers(st, action, self),
        ),
    );
    expect(
      uncovered,
      `infra/BOOTSTRAP.md documents an explicit Deny on ${deployRoleName} ` +
        `itself as a standing control. These actions are no longer covered ` +
        `by it.`,
    ).toEqual([]);
  });

  it("cannot rewrite its own permissions", () => {
    // The boundaries cap the roles the deploy creates, not the deploy role
    // itself -- so if the deploy role could edit its own policy or trust
    // policy, none of the above would hold for long. Net effect is what
    // matters: an Allow that reaches the deploy role is fine only if a Deny
    // covers the same action on it.
    const self = roleArn(deployRoleName);
    const reachable = ROLE_MUTATING_ACTIONS.filter((action) => {
      const allowed = allows(deployStatements, action, self);
      const denied = deployStatements.some(
        (st) => st.effect === "Deny" && covers(st, action, self),
      );
      return allowed && !denied;
    });
    expect(
      reachable,
      `the deploy policy grants these on ${deployRoleName} itself with no ` +
        `Deny to cancel them, so an assumed session could rewrite its own ` +
        `permissions and the boundaries would stop meaning anything. Either ` +
        `narrow the Resource pattern away from the deploy role, or extend ` +
        `the DenySelfModification statement.`,
    ).toEqual([]);
  });

  it("holds no budgets write, and passes roles only to Lambda and Bedrock", () => {
    // The backstop is human-owned. The budgets statements the deploy role
    // held while Terraform managed it are gone, and must not come back.
    const budgetWrites = BUDGET_WRITE_ACTIONS.filter(
      (action) => allowedPatternsFor(deployStatements, action).length > 0,
    );
    expect(budgetWrites, "the deploy policy allows budgets writes").toEqual([]);

    const passedTo = deployStatements
      .filter((st) => st.effect === "Allow" && st.actions.some((a) => matchesGlob(a, "iam:PassRole")))
      .map((st) => {
        const eq = asObject(asObject((st.raw as { Condition?: HclValue }).Condition)?.StringEquals);
        const svc = eq?.["iam:PassedToService"];
        return typeof svc === "string" ? svc : `(unconditioned: ${st.sid ?? "?"})`;
      });
    expect(sorted(passedTo)).toEqual([
      "bedrock.amazonaws.com",
      "lambda.amazonaws.com",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The update role (infra/BOOTSTRAP.md section 3e) is assumed by deploy runs
// in the `aws` environment, which has no required reviewer. Its whole safety
// case is how little it can write, so its grants are pinned statement by
// statement, resource by resource. A provider bump that needs more fails with
// AccessDenied and routes to the gated deploy role; it never needs this
// table widened to keep working.

const STATE = `bbb-mcp-tfstate-${A}`;
const CORPUS = `bbb-mcp-corpus-${A}`;
const EXPECTED_UPDATE_ALLOWS: Record<string, { actions: string[]; resources: string[] }> = {
  TerraformStateList: {
    actions: ["s3:ListBucket"],
    resources: [`arn:aws:s3:::${STATE}`],
  },
  TerraformStateRW: {
    actions: ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"],
    resources: [`arn:aws:s3:::${STATE}/bbb-mcp/*`],
  },
  LambdaCodeOnly: {
    actions: ["lambda:UpdateFunctionCode"],
    resources: [`arn:aws:lambda:${R}:${A}:function:bbb-mcp-server`],
  },
  LambdaTags: {
    actions: ["lambda:TagResource", "lambda:UntagResource"],
    resources: [`arn:aws:lambda:${R}:${A}:function:bbb-mcp-server`],
  },
  LambdaRead: {
    actions: ["lambda:Get*", "lambda:List*"],
    resources: [`arn:aws:lambda:${R}:${A}:function:bbb-mcp-*`],
  },
  CorpusObjects: {
    actions: ["s3:DeleteObject", "s3:PutObject"],
    resources: [`arn:aws:s3:::${CORPUS}/*`],
  },
  CorpusTags: {
    actions: ["s3:PutBucketTagging"],
    resources: [`arn:aws:s3:::${CORPUS}`],
  },
  CorpusRead: {
    actions: ["s3:Get*", "s3:List*"],
    resources: [`arn:aws:s3:::${CORPUS}`, `arn:aws:s3:::${CORPUS}/*`],
  },
  VectorStoreTags: {
    actions: ["s3vectors:TagResource", "s3vectors:UntagResource"],
    resources: [
      `arn:aws:s3vectors:${R}:${A}:bucket/bbb-mcp-*`,
      `arn:aws:s3vectors:${R}:${A}:bucket/bbb-mcp-*/index/*`,
    ],
  },
  VectorStoreRead: {
    actions: ["s3vectors:Get*", "s3vectors:List*"],
    resources: [
      `arn:aws:s3vectors:${R}:${A}:bucket/bbb-mcp-*`,
      `arn:aws:s3vectors:${R}:${A}:bucket/bbb-mcp-*/index/*`,
    ],
  },
  KnowledgeBaseIngest: {
    actions: ["bedrock:GetIngestionJob", "bedrock:StartIngestionJob"],
    resources: [`arn:aws:bedrock:${R}:${A}:knowledge-base/*`],
  },
  KnowledgeBaseTags: {
    actions: ["bedrock:TagResource", "bedrock:UntagResource"],
    resources: [`arn:aws:bedrock:${R}:${A}:knowledge-base/*`],
  },
  KnowledgeBaseRead: {
    actions: ["bedrock:Get*", "bedrock:List*"],
    resources: [`arn:aws:bedrock:${R}:${A}:knowledge-base/*`],
  },
  LogGroupRead: {
    actions: ["logs:Describe*", "logs:List*"],
    resources: [`arn:aws:logs:${R}:${A}:log-group:*`],
  },
  ApiGatewayRead: {
    actions: ["apigateway:GET"],
    resources: [`arn:aws:apigateway:${R}::/*`],
  },
  StackRoleRead: {
    actions: ["iam:Get*", "iam:List*"],
    resources: [
      `arn:aws:iam::${A}:policy/bbb-mcp-*`,
      `arn:aws:iam::${A}:role/bbb-mcp-kb-*`,
      `arn:aws:iam::${A}:role/bbb-mcp-server-*`,
    ],
  },
  BackstopRead: {
    actions: ["budgets:DescribeBudgetAction*", "budgets:ViewBudget"],
    resources: [`arn:aws:budgets::${A}:budget/bbb-backstop-*`],
  },
};

// What the update role may write, and nothing more: the Lambda's code, tags
// on four resource types, corpus objects, ingestion, and Terraform state.
const UPDATE_WRITE_ACTIONS = [
  "bedrock:StartIngestionJob",
  "bedrock:TagResource",
  "bedrock:UntagResource",
  "lambda:TagResource",
  "lambda:UntagResource",
  "lambda:UpdateFunctionCode",
  "s3:DeleteObject",
  "s3:PutBucketTagging",
  "s3:PutObject",
  "s3vectors:TagResource",
  "s3vectors:UntagResource",
];

// Never on the update role, whatever the resource. Checked against the
// action patterns alone, so a wildcard (`lambda:*`, `iam:Pass*`) trips it.
const UPDATE_FORBIDDEN_ACTIONS = [
  ...ROLE_MUTATING_ACTIONS,
  "iam:PassRole",
  "iam:CreatePolicy",
  "iam:CreatePolicyVersion",
  "iam:DeletePolicy",
  "iam:SetDefaultPolicyVersion",
  "iam:TagRole",
  "iam:UntagRole",
  "lambda:InvokeFunction",
  "lambda:InvokeFunctionUrl",
  "lambda:UpdateFunctionConfiguration",
  "lambda:CreateFunction",
  "lambda:DeleteFunction",
  "lambda:AddPermission",
  "lambda:PutFunctionConcurrency",
  "lambda:UpdateFunctionUrlConfig",
  "apigateway:POST",
  "apigateway:PUT",
  "apigateway:PATCH",
  "apigateway:DELETE",
  "bedrock:InvokeModel",
  "bedrock:RetrieveAndGenerate",
  "bedrock:DeleteKnowledgeBase",
  "bedrock:UpdateKnowledgeBase",
  "bedrock:UpdateDataSource",
  "s3:DeleteBucket",
  "s3:PutBucketPolicy",
  "s3vectors:DeleteIndex",
  "s3vectors:DeleteVectorBucket",
  "logs:DeleteLogGroup",
  "logs:PutRetentionPolicy",
];

const isReadAction = (a: string) =>
  /^[a-z0-9-]+:(Get|List|Describe|View)/.test(a) || a === "apigateway:GET";

describe("the update role can replace the Lambda's code and little else", () => {
  it("is created by the bootstrap under its expected name", () => {
    expect(updateRoleName).toBe("bbb-mcp-update");
  });

  it("is granted exactly the pinned statements", () => {
    const actual = Object.fromEntries(
      updateStatements
        .filter((st) => st.effect === "Allow")
        .map((st) => [
          st.sid ?? "(no Sid)",
          { actions: sorted(st.actions), resources: sorted(resourcesOf(st)) },
        ]),
    );
    expect(
      actual,
      "the update role's Allow statements differ from EXPECTED_UPDATE_ALLOWS. " +
        "This role deploys with no human approval, so every widening is a " +
        "reviewed edit to that table.",
    ).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_UPDATE_ALLOWS).map(([sid, v]) => [
          sid,
          { actions: sorted(v.actions), resources: sorted(v.resources) },
        ]),
      ),
    );
  });

  it("writes only the code, tags, corpus, ingestion and state", () => {
    const writes = updateStatements
      .filter((st) => st.effect === "Allow")
      .flatMap((st) => st.actions)
      .filter((a) => !isReadAction(a));
    expect(sorted(new Set(writes))).toEqual(sorted(UPDATE_WRITE_ACTIONS));
  });

  it("holds no IAM write, no PassRole, no invoke and no configuration change", () => {
    const reachable = UPDATE_FORBIDDEN_ACTIONS.filter(
      (action) => allowedPatternsFor(updateStatements, action).length > 0,
    );
    expect(
      reachable,
      "the update role allows these, at least by wildcard. It must not: it " +
        "runs unattended, and these would let it reshape roles, change the " +
        "Lambda's configuration or call the server around the API key.",
    ).toEqual([]);
    const iamActions = updateStatements
      .filter((st) => st.effect === "Allow")
      .flatMap((st) => st.actions)
      .filter((a) => a.startsWith("iam:") || a === "*");
    expect(iamActions.filter((a) => !isReadAction(a))).toEqual([]);
  });

  it("can update the code of exactly one function", () => {
    const fn = (name: string) => `arn:aws:lambda:${R}:${A}:function:${name}`;
    expect(allows(updateStatements, "lambda:UpdateFunctionCode", fn("bbb-mcp-server"))).toBe(true);
    for (const other of ["bbb-mcp-server2", "bbb-mcp-other", "unrelated"]) {
      expect(allows(updateStatements, "lambda:UpdateFunctionCode", fn(other)), other).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The human-owned cost backstop (infra/BOOTSTRAP.md section 3d). It is safe
// against both deploy roles only while (a) neither can write it, (b) neither
// can detach its deny policy, and (c) it covers every role that can spend.

const BUDGET_WRITE_ACTIONS = [
  "budgets:ModifyBudget",
  "budgets:CreateBudgetAction",
  "budgets:UpdateBudgetAction",
  "budgets:DeleteBudgetAction",
  "budgets:ExecuteBudgetAction",
  "budgets:TagResource",
  "budgets:UntagResource",
];
const BACKSTOP_WRITES: [string, string][] = [
  ...[
    ...ROLE_MUTATING_ACTIONS,
    "iam:PassRole",
    "iam:TagRole",
    "iam:UntagRole",
    "iam:UpdateRoleDescription",
  ].map((a): [string, string] => [a, roleArn(BACKSTOP_ROLE)]),
  ...[
    "iam:CreatePolicy",
    "iam:CreatePolicyVersion",
    "iam:DeletePolicy",
    "iam:DeletePolicyVersion",
    "iam:SetDefaultPolicyVersion",
    "iam:TagPolicy",
    "iam:UntagPolicy",
  ].map((a): [string, string] => [a, policyArn(BACKSTOP_DENY)]),
  ...BUDGET_WRITE_ACTIONS.flatMap((a): [string, string][] => [
    [a, budgetArn(BACKSTOP_BUDGET)],
    [a, `${budgetArn(BACKSTOP_BUDGET)}/action/00000000-0000-0000-0000-000000000000`],
  ]),
];

// Names neither GitHub Actions role may hold any non-read grant on.
const PROTECTED_ARNS = [
  roleArn(BACKSTOP_ROLE),
  policyArn(BACKSTOP_DENY),
  budgetArn(BACKSTOP_BUDGET),
  `${budgetArn(BACKSTOP_BUDGET)}/action/00000000-0000-0000-0000-000000000000`,
  roleArn("bbb-mcp-update"),
];

/** The iam:PolicyARN pattern a Deny is conditioned on, or null. */
function policyArnCondition(st: PolicyStatement): string | null {
  const cond = asObject((st.raw as { Condition?: HclValue }).Condition);
  if (cond === null) return null;
  const ops = Object.keys(cond);
  // A single positive ARN operator with a single key. Anything else (an
  // ArnNotLike, a second key that narrows when the Deny applies) would make
  // the Deny weaker than it reads.
  if (ops.length !== 1 || !["ArnEquals", "ArnLike"].includes(ops[0])) return null;
  const inner = asObject(cond[ops[0]]);
  if (inner === null || Object.keys(inner).length !== 1) return null;
  const value = inner["iam:PolicyARN"];
  return typeof value === "string" ? value : null;
}

const GH_ROLES: [string, () => PolicyStatement[]][] = [
  ["bbb-mcp-deploy (gated)", () => deployStatements],
  ["bbb-mcp-update (unattended)", () => updateStatements],
];

describe("neither GitHub Actions role can disarm the backstop", () => {
  for (const [label, statements] of GH_ROLES) {
    it(`${label} is denied every write to the backstop`, () => {
      const sts = statements();
      const gaps = BACKSTOP_WRITES.filter(
        ([action, arn]) =>
          !sts.some(
            (st) =>
              st.effect === "Deny" &&
              (st.raw as { Condition?: HclValue }).Condition === undefined &&
              covers(st, action, arn),
          ),
      ).map(([action, arn]) => `${action} on ${arn}`);
      expect(gaps, `${label} has no unconditional Deny for these`).toEqual([]);
    });

    it(`${label} is denied detaching the backstop deny from any role`, () => {
      // A detach is authorised against the ROLE, so a Deny keyed on the
      // policy's ARN as a resource would never match. The Deny must cover
      // every role and be conditioned on iam:PolicyARN.
      const sts = statements();
      const targets = [...expectedBackstopTargets(), "bbb-mcp-server-exec2"];
      const uncovered = targets.filter(
        (role) =>
          !sts.some((st) => {
            const pattern = policyArnCondition(st);
            return (
              st.effect === "Deny" &&
              pattern !== null &&
              matchesGlob(pattern, policyArn(BACKSTOP_DENY)) &&
              covers(st, "iam:DetachRolePolicy", roleArn(role))
            );
          }),
      );
      expect(uncovered).toEqual([]);
    });

    it(`${label} holds no non-read Allow on the backstop or the update role`, () => {
      // Read with the service in mind: a Resource "*" on a bedrock statement
      // does not grant IAM or budgets actions on these ARNs.
      const offending: string[] = [];
      for (const st of statements()) {
        if (st.effect !== "Allow") continue;
        for (const arn of PROTECTED_ARNS) {
          if (!resourcesOf(st).some((r) => matchesGlob(r, arn))) continue;
          const service = arn.split(":")[2];
          const sameService = st.actions.filter(
            (a) => a === "*" || a.split(":")[0] === service,
          );
          for (const a of sameService.filter((x) => !isReadAction(x))) {
            offending.push(`${st.sid ?? "(no Sid)"}: ${a} on ${arn}`);
          }
        }
      }
      expect(offending).toEqual([]);
    });
  }
});

/** Every role that can spend: the Terraform roles plus the unattended
 * GitHub Actions roles. The gated deploy role is not a target (it is how a
 * human repairs things), and neither is the backstop's own role. */
function expectedBackstopTargets(): string[] {
  return sorted([...roles.map((r) => r.name), "bbb-mcp-update", CORPUS_SYNC_ROLE]);
}

describe("the backstop is human-owned and covers every role that can spend", () => {
  const definition = doc("/tmp/backstop-action-definition.json") as {
    IamActionDefinition?: { PolicyArn?: string; Roles?: string[] };
  } | null;

  it("is not in the Terraform stack", () => {
    expect(resourceLabels("aws_budgets_budget")).toEqual([]);
    expect(resourceLabels("aws_budgets_budget_action")).toEqual([]);
  });

  it("was forgotten by Terraform, not destroyed", () => {
    expect(
      sorted(removed.map((r) => `${r.from} destroy=${r.destroy}`)),
    ).toEqual(
      sorted([
        "aws_budgets_budget_action.deny_bedrock",
        "aws_budgets_budget.mcp",
        "aws_iam_role_policy.budgets",
        "aws_iam_role.budgets",
        "aws_iam_policy.bedrock_deny",
      ].map((a) => `${a} destroy=false`)),
    );
  });

  it("the bootstrap creates exactly the three expected managed policies", () => {
    expect(sorted(managedPolicyCalls.map((c) => c.name))).toEqual(
      sorted([BACKSTOP_DENY, IAM_BOUNDARY, WORKLOAD_BOUNDARY]),
    );
  });

  it("denies exactly the spending actions", () => {
    const sts = statementsIn("/tmp/backstop-deny.json");
    expect(sts.length).toBeGreaterThan(0);
    expect(sts.every((st) => st.effect === "Deny")).toBe(true);
    expect(sorted(sts.flatMap((st) => st.actions))).toEqual([
      "bedrock:*",
      "logs:PutLogEvents",
      "s3:PutObject",
    ]);
    expect(sts.flatMap((st) => resourcesOf(st))).toEqual(sts.map(() => "*"));
  });

  it("attaches the deny to every role that can spend", () => {
    expect(definition?.IamActionDefinition?.PolicyArn).toBe(policyArn(BACKSTOP_DENY));
    expect(sorted(definition?.IamActionDefinition?.Roles ?? [])).toEqual(
      expectedBackstopTargets(),
    );
    // The script's existence check walks the same list.
    const list = bootstrapShellAssignments("BACKSTOP_ROLES");
    expect(list).toHaveLength(1);
    expect(sorted(list[0].replace(/"/g, "").split(/\s+/))).toEqual(
      expectedBackstopTargets(),
    );
  });

  it("scopes the action role and its boundary to exactly those roles", () => {
    const targets = expectedBackstopTargets().map(roleArn);
    for (const [what, sts] of [
      ["backstop action role policy", statementsIn("/tmp/backstop-action-policy.json")],
      [IAM_BOUNDARY, statementsIn("/tmp/boundary-iam.json")],
    ] as const) {
      expect(sts.length, what).toBeGreaterThan(0);
      for (const st of sts) {
        expect(sorted(resourcesOf(st)), `${what} ${st.sid ?? ""}`).toEqual(targets);
      }
    }
    // Attach and detach are pinned to the one deny policy.
    for (const st of statementsIn("/tmp/backstop-action-policy.json")) {
      if (!st.actions.some((a) => a === "iam:AttachRolePolicy" || a === "iam:DetachRolePolicy")) continue;
      const cond = asObject(asObject((st.raw as { Condition?: HclValue }).Condition)?.ArnEquals);
      expect(cond?.["iam:PolicyARN"], st.sid).toBe(policyArn(BACKSTOP_DENY));
    }
  });

  it("caps its action role with the IAM boundary, on creation and on re-run", () => {
    expect(
      sorted(createdRoles.map((r) => `${r.name} boundary=${r.boundary ?? "none"}`)),
    ).toEqual(
      sorted(
        Object.keys(HAND_MADE_ROLES).map(
          (n) => `${n} boundary=${n === BACKSTOP_ROLE ? IAM_BOUNDARY : "none"}`,
        ),
      ),
    );
    expect(boundaryRefreshes).toEqual([{ role: BACKSTOP_ROLE, boundary: IAM_BOUNDARY }]);
  });

  it("fires automatically at 100% of actual spend, through its own role", () => {
    const creates = bootstrapCommands("budgets create-budget-action");
    expect(creates).toHaveLength(1);
    for (const flag of [
      `--budget-name ${BACKSTOP_BUDGET}`,
      "--notification-type ACTUAL",
      "--action-type APPLY_IAM_POLICY",
      "--action-threshold ActionThresholdValue=100,ActionThresholdType=PERCENTAGE",
      "--definition file:///tmp/backstop-action-definition.json",
      `--execution-role-arn "${roleArn(BACKSTOP_ROLE)}"`,
      "--approval-model AUTOMATIC",
    ]) {
      expect(creates[0], flag).toContain(flag);
    }
    const updates = bootstrapCommands("budgets update-budget-action");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("--definition file:///tmp/backstop-action-definition.json");
    const budget = doc("/tmp/backstop-budget.json") as { BudgetName?: string } | null;
    expect(budget?.BudgetName).toBe(BACKSTOP_BUDGET);
  });

  it("creates the update role before arming the action that targets it", () => {
    const flat = bootstrapFlatText();
    const role = flat.indexOf("aws iam create-role --role-name bbb-mcp-update");
    const action = flat.indexOf("aws budgets create-budget-action");
    expect(role).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(role);
  });
});

// ---------------------------------------------------------------------------
// Trust. Each GitHub Actions role trusts exactly one OIDC subject, all three
// derived in the script from one repo prefix. StringEquals only: a
// StringLike on a subject is how a trust policy quietly starts accepting
// branches, environments or repos nobody meant.

const OIDC = "token.actions.githubusercontent.com";

/** The OIDC subjects a GitHub trust document accepts (StringEquals only). */
function trustSubjects(d: HclValue | null, what: string): string[] {
  if (d === null) throw new Error(`${what} could not be read`);
  const statements = statementsOf(d, what);
  if (statements.length !== 1) {
    throw new Error(`${what} has ${statements.length} statements, expected 1`);
  }
  const st = statements[0];
  if (st.effect !== "Allow" || st.actions.join() !== "sts:AssumeRoleWithWebIdentity") {
    throw new Error(`${what} is not an OIDC web-identity trust`);
  }
  const principal = asObject((st.raw as { Principal?: HclValue }).Principal);
  if (principal?.Federated !== `arn:aws:iam::${A}:oidc-provider/${OIDC}`) {
    throw new Error(`${what} does not trust the GitHub OIDC provider`);
  }
  const cond = asObject((st.raw as { Condition?: HclValue }).Condition);
  if (cond === null) throw new Error(`${what} has no Condition object`);
  if (Object.keys(cond).join() !== "StringEquals") {
    throw new Error(
      `${what} uses condition operators ${Object.keys(cond).join(", ")}; ` +
        "a GitHub trust must use StringEquals only",
    );
  }
  const eq = asObject(cond.StringEquals);
  if (eq === null) throw new Error(`${what} has no StringEquals object`);
  if (sorted(Object.keys(eq)).join() !== `${OIDC}:aud,${OIDC}:sub`) {
    throw new Error(`${what} conditions on ${Object.keys(eq).join(", ")}`);
  }
  if (eq[`${OIDC}:aud`] !== "sts.amazonaws.com") {
    throw new Error(`${what} does not pin the sts.amazonaws.com audience`);
  }
  return sorted(stringList(eq[`${OIDC}:sub`], `${what} sub`));
}

describe("each role trusts exactly the identity it is meant to", () => {
  it("the bootstrap creates exactly the four hand-made roles and policies", () => {
    expect(
      sorted(createdRoles.map((r) => `${r.name} <- ${r.trustPath}`)),
    ).toEqual(
      sorted(Object.entries(HAND_MADE_ROLES).map(([n, p]) => `${n} <- ${p}`)),
    );
    expect(
      sorted(bootstrapPolicies.map((p) => `${p.role} <- ${p.docPath}`)),
    ).toEqual(
      sorted(Object.entries(HAND_MADE_POLICIES).map(([n, p]) => `${n} <- ${p}`)),
    );
  });

  it("derives all three subjects from one repo prefix", () => {
    // Literal: a re-run with a different prefix moves all three together, so
    // no two trust policies can disagree on the repo.
    const prefix = bootstrapShellAssignments("GITHUB_REPO_SUB");
    expect(prefix).toHaveLength(1);
    expect(prefix[0]).toMatch(/^"repo:[^":]+"$/);
    for (const [name, tail] of Object.entries(SUBJECT_TAILS)) {
      expect(bootstrapShellAssignments(name), name).toEqual([
        `"\${GITHUB_REPO_SUB}${tail}"`,
      ]);
    }
    expect(bootstrapShellAssignments("GITHUB_SUB")).toEqual([]);
    expect(bootstrapFlatText()).not.toContain("${GITHUB_SUB}");
  });

  it("the deploy role trusts the reviewer-gated aws-gated environment only", () => {
    expect(trustSubjects(doc("/tmp/trust.json"), "deploy trust")).toEqual([
      PLACEHOLDER_SUBS.deploy,
    ]);
  });

  it("the update role trusts the aws environment only", () => {
    expect(trustSubjects(doc("/tmp/update-trust.json"), "update trust")).toEqual([
      PLACEHOLDER_SUBS.update,
    ]);
  });

  it("the corpus-sync role trusts the main ref only", () => {
    // Named for what it checks. The subject restricts by ref, not by event
    // or workflow, so this proves the heredoc uses the right variable -- not
    // that only the corpus-sync workflow can assume the role. What bounds
    // that is the role's narrowness plus the OIDC-token guard in
    // tests/corpus-sync-workflow.test.ts.
    expect(trustSubjects(doc("/tmp/corpus-trust.json"), "corpus-sync trust")).toEqual([
      PLACEHOLDER_SUBS.corpusSync,
    ]);
  });

  it("the migration's transition trust accepts exactly the old and new subjects", () => {
    expect(
      trustSubjects(doc("/tmp/deploy-trust-transition.json"), "transition trust"),
    ).toEqual(sorted([PLACEHOLDER_SUBS.deploy, PLACEHOLDER_SUBS.update]));
  });

  it("the backstop role trusts AWS Budgets in this account only", () => {
    const sts = statementsIn("/tmp/backstop-action-trust.json");
    expect(sts).toHaveLength(1);
    const principal = asObject((sts[0].raw as { Principal?: HclValue }).Principal);
    expect(principal?.Service).toBe("budgets.amazonaws.com");
    expect(sts[0].actions).toEqual(["sts:AssumeRole"]);
    expect((sts[0].raw as { Condition?: HclValue }).Condition).toEqual({
      StringEquals: { "aws:SourceAccount": A },
    });
  });
});

// ---------------------------------------------------------------------------
// Paste A of the auto-deploy migration runs section 3b in its `transition`
// stage, before the merge that makes Terraform forget the old backstop. The
// narrowed deploy policy cannot read that old backstop, so applying it early
// would break the very run that hands it over.

describe("the migration's Paste A cannot apply the narrowed deploy policy", () => {
  const branches = safely(
    "section 3b DEPLOY_ROLE_STAGE switch",
    bootstrapDeployStageBranches,
    { transition: "", final: "" },
  );
  const text = bootstrapFlatText();
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;

  it("defaults the stage to final", () => {
    expect(bootstrapShellAssignments("DEPLOY_ROLE_STAGE")).toEqual(['"final"']);
  });

  it("the transition stage only widens the trust", () => {
    expect(branches.transition).toContain("file:///tmp/deploy-trust-transition.json");
    expect(branches.transition).not.toContain("put-role-policy");
    expect(branches.transition).not.toContain("create-role");
    expect(branches.transition).not.toContain("/tmp/policy.json");
    expect(branches.transition).not.toContain("/tmp/trust.json");
  });

  it("only the final stage applies the deploy policy and final trust", () => {
    for (const ref of ["file:///tmp/policy.json", "file:///tmp/trust.json"]) {
      expect(count(branches.final, ref), ref).toBeGreaterThan(0);
      expect(count(text, ref), `${ref} used outside the final stage`).toBe(
        count(branches.final.replace(/\\\n\s*/g, " "), ref),
      );
    }
    expect(count(text, "file:///tmp/deploy-trust-transition.json")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The hand-made roles stay out of the pipeline's reach. Each is named outside
// every pattern the deploy and update policies grant IAM writes on, so no
// run, gated or not, can widen one; this pins that, wildcard-aware.

describe("no GitHub Actions role can create, rewrite, or delete a hand-made role", () => {
  for (const [label, statements] of GH_ROLES) {
    for (const role of [CORPUS_SYNC_ROLE, "bbb-mcp-update", BACKSTOP_ROLE]) {
      it(`${label} cannot touch ${role}`, () => {
        const arn = roleArn(role);
        const reachable = [...ROLE_MUTATING_ACTIONS, "iam:PassRole"].filter(
          (action) => allows(statements(), action, arn),
        );
        expect(
          reachable,
          `${label} allows these on ${role}, so a pipeline run could widen ` +
            `a role it is meant to be bounded by`,
        ).toEqual([]);
      });
    }
  }

  it("the update role cannot touch the deploy role either", () => {
    const arn = roleArn(deployRoleName);
    const reachable = [...ROLE_MUTATING_ACTIONS, "iam:PassRole"].filter(
      (action) => allows(updateStatements, action, arn),
    );
    expect(reachable).toEqual([]);
  });
});

describe("the corpus-sync role stays a docs publisher and nothing more", () => {
  const corpusPolicyDoc = doc("/tmp/corpus-policy.json");

  it("is granted exactly the corpus-publisher actions, no wildcards", () => {
    expect(corpusPolicyDoc).not.toBeNull();
    const { actions } = allowedActions(corpusPolicyDoc!, "corpus-sync policy");
    expect(sorted(actions)).toEqual([
      "bedrock:GetIngestionJob",
      "bedrock:StartIngestionJob",
      "s3:DeleteObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]);
  });

  it("reaches only the corpus bucket and the account's knowledge bases", () => {
    // The actions above are safe because of what they point at. s3:PutObject
    // on the Terraform STATE bucket, say, would let an unattended push
    // rewrite state; scoped to the corpus bucket it can only republish docs.
    //
    // Compared as exact strings, not prefixes: a prefix check would accept a
    // silent broadening (`knowledge-base/*` widening further, or the bucket
    // pattern growing a wildcard) while still reading as scoped.
    expect(corpusPolicyDoc).not.toBeNull();
    const statements = statementsOf(corpusPolicyDoc!, "corpus-sync policy");
    expect(sorted(statements.flatMap((st) => resourcesOf(st)))).toEqual([
      `arn:aws:bedrock:${R}:${A}:knowledge-base/*`,
      `arn:aws:s3:::bbb-mcp-corpus-${A}`,
      `arn:aws:s3:::bbb-mcp-corpus-${A}/*`,
    ]);
    // The knowledge-base wildcard is deliberate (the id does not exist at
    // bootstrap time) and acceptable only while the account holds this
    // stack's single knowledge base. Pinned above so widening it past that
    // has to be a reviewed edit rather than a silent one.
  });
});
