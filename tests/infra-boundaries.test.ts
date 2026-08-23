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
  bootstrapDeployRoleName,
  bootstrapJson,
  countResources,
  permissionsBoundaryCount,
  PLACEHOLDER_ACCOUNT_ID,
  resourceLabels,
  terraformRolePolicies,
  terraformRoles,
} from "./helpers/infra-policies";

// Permissions boundary drift guard (issue #101).
//
// The two IAM permissions boundaries that cap every role the MCP stack
// creates live in infra/BOOTSTRAP.md, as a script a human pastes into
// CloudShell. The roles they cap, and the policies attached to those roles,
// live in infra/*.tf and are written by an automated deploy. That split is
// deliberate: the deploy role can version bbb-mcp-* policies, so a
// Terraform-managed boundary could be widened by the very thing it exists to
// constrain.
//
// The cost of the split is that the two artifacts can drift, silently, in
// both directions:
//
//   * A role policy grows past its boundary. Effective permissions are the
//     INTERSECTION of the two, so the new capability is simply dead. It fails
//     as an AccessDenied at runtime, not at apply time, in a stack that is
//     deployed behind a human approval gate and exercised by nobody.
//
//   * A boundary grows past its roles. Nothing breaks, so nothing complains,
//     and the ceiling quietly stops being a ceiling. That is exactly how the
//     first cut of this design went wrong: a single union boundary handed the
//     server role an IAM ceiling only the budget-action role needed, which
//     would have let a rewritten server policy detach the bedrock-deny cost
//     backstop.
//
// So the invariant asserted here is equality, not containment: each boundary
// allows exactly the actions the roles it caps actually use.
//
// SCOPE, stated plainly so nobody reads more assurance into a green run than
// it earns:
//
//   * ACTIONS only. Resource scoping and conditions are not compared, and
//     remain a matter for review. A role policy that kept its actions and
//     widened `Resource` to "*" passes.
//   * Boundary parity is per boundary, against the UNION of the roles it
//     caps. `bbb-mcp-boundary-workload` caps two roles, so the union is the
//     only thing that can equal it. Cross-contamination between those two
//     (the knowledge-base role taking an action only the server needs) is
//     caught instead by EXPECTED_ROLE_ACTIONS below, which pins each role's
//     grants individually.
//   * Everything is read from the committed files. This proves the two
//     artifacts agree with each other, not that either matches the live AWS
//     account.

const ROLE_COUNT = 3;
const ROLE_POLICY_COUNT = 4;
const BOUNDARY_COUNT = 2;

// Every IAM resource type in infra/*.tf that can grant a role permissions,
// with the labels allowed to exist. A managed policy attached via
// aws_iam_role_policy_attachment grants a role exactly as an inline policy
// does, and this guard reads only inline policies -- so rather than model the
// other route, assert it does not appear. bedrock_deny is the one managed
// policy, and it is a Deny attached at runtime by the budget action, never by
// Terraform.
const ALLOWED_IAM_RESOURCES: Record<string, string[]> = {
  aws_iam_policy: ["bedrock_deny"],
  aws_iam_role_policy_attachment: [],
  aws_iam_user_policy: [],
  aws_iam_user_policy_attachment: [],
  aws_iam_group_policy: [],
  aws_iam_group_policy_attachment: [],
};

// Exactly what each role may be granted, pinned so an IAM change cannot land
// without a reviewed diff here. This is the per-role complement to the
// per-boundary parity below: the union of these must equal the boundaries,
// and each individual set must equal this table.
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
  "bbb-mcp-budgets-action": [
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
  "infra/BOOTSTRAP.md put_boundary calls",
  bootstrapBoundaryCalls,
  [],
);
const deployRoleName = safely(
  "infra/BOOTSTRAP.md deploy role name",
  bootstrapDeployRoleName,
  "",
);

const roleArn = (name: string) =>
  `arn:aws:iam::${PLACEHOLDER_ACCOUNT_ID}:role/${name}`;
const policyArn = (name: string) =>
  `arn:aws:iam::${PLACEHOLDER_ACCOUNT_ID}:policy/${name}`;

/** Boundary policy name -> its parsed document. */
const boundaryDocs = new Map<string, HclValue>(
  boundaryCalls
    .map(({ name, path }) => [
      name,
      safely<HclValue | null>(`boundary document ${path}`, () => bootstrapJson(path), null),
    ])
    .filter((entry): entry is [string, HclValue] => entry[1] !== null),
);

/** Boundary policy name -> the actions its document allows. */
const boundaryActions = new Map<string, Set<string>>(
  [...boundaryDocs].map(([name, doc]) => [
    name,
    safely(`boundary document ${name}`, () => allowedActions(doc, name).actions, new Set<string>()),
  ]),
);

/** Boundary policy name -> the roles Terraform caps with it. */
function rolesByBoundary(): Map<string, typeof roles> {
  const out = new Map<string, typeof roles>();
  for (const role of roles) {
    const key = (role.boundaryLocal ?? "").replace(/^local\./, "");
    const name = locals[key];
    if (!name) continue; // asserted separately below
    const list = out.get(name) ?? [];
    list.push(role);
    out.set(name, list);
  }
  return out;
}

/** Terraform role label -> the actions its inline policies allow. */
function actionsByRole(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const policy of rolePolicies) {
    const { actions } = allowedActions(policy.document, policy.ref);
    const set = out.get(policy.roleRef) ?? new Set<string>();
    for (const a of actions) set.add(a);
    out.set(policy.roleRef, set);
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
      const key = (role.boundaryLocal ?? "").replace(/^local\./, "");
      const name = locals[key];
      expect(name, `local.${key} is not a boundary ARN in infra/*.tf`).toBeDefined();
      expect(
        created,
        `aws_iam_role.${role.ref} is capped with ${name}, which ` +
          `infra/BOOTSTRAP.md never creates`,
      ).toContain(name);
    }
  });

  it("uses both boundaries (an unused one is a boundary nobody is testing)", () => {
    expect(sorted(rolesByBoundary().keys())).toEqual(
      sorted(boundaryCalls.map((c) => c.name)),
    );
  });
});

describe("each role is granted exactly what it is meant to be granted", () => {
  const byRole = actionsByRole();

  for (const role of roles) {
    it(`${role.name}`, () => {
      const expected = EXPECTED_ROLE_ACTIONS[role.name];
      expect(
        expected,
        `${role.name} has no entry in EXPECTED_ROLE_ACTIONS. A new role's ` +
          `grants must be written down here to be reviewable.`,
      ).toBeDefined();
      expect(
        sorted(byRole.get(role.ref) ?? []),
        `the inline policies for ${role.name} grant a different action set ` +
          `than EXPECTED_ROLE_ACTIONS records. If the change is intended, ` +
          `update the table in this file; that diff is the review.`,
      ).toEqual(sorted(expected ?? []));
    });
  }

  it("covers every role and nothing else", () => {
    expect(sorted(Object.keys(EXPECTED_ROLE_ACTIONS))).toEqual(
      sorted(roles.map((r) => r.name)),
    );
  });
});

describe("each boundary allows exactly what its roles use", () => {
  const byBoundary = rolesByBoundary();
  const byRole = actionsByRole();

  for (const [boundary, actions] of boundaryActions) {
    const capped = byBoundary.get(boundary) ?? [];
    const used = new Set<string>();
    for (const role of capped) {
      for (const a of byRole.get(role.ref) ?? []) used.add(a);
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
        `these actions are granted in infra/*.tf but not permitted by ` +
          `${boundary} in infra/BOOTSTRAP.md, so they cannot take effect. ` +
          `Widen the boundary in the bootstrap script (section 3a) and re-run ` +
          `the paste.`,
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

  it("no role-policy action is a wildcard", () => {
    for (const policy of rolePolicies) {
      const { actions } = allowedActions(policy.document, policy.ref);
      expect(
        sorted(actions).filter((a) => a.includes("*")),
        policy.ref,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The deploy role's own policy is what makes the boundaries stick: it may only
// create these roles WITH a boundary attached, may not swap one boundary for
// the other, may not edit or remove either, and may not rewrite itself. Those
// clauses and the Terraform they constrain are in two different files, so they
// can drift too.
//
// Everything below matches wildcards properly (`iam:*` counts as granting
// `iam:CreateRole`; a Deny on `policy/bbb-mcp-boundary-*` counts as covering a
// specific boundary), because the deploy policy already uses wildcard actions
// and wildcard resources as a matter of house style.

const deployStatements = safely<PolicyStatement[]>(
  "infra/BOOTSTRAP.md deploy policy",
  () => statementsOf(bootstrapJson("/tmp/policy.json"), "deploy policy"),
  [],
);

function resourcesOf(st: PolicyStatement): string[] {
  const raw = (st.raw as { Resource?: HclValue }).Resource;
  if (raw === undefined) throw new Error(`${st.sid ?? "?"} has no Resource`);
  return stringList(raw, `${st.sid ?? "?"} Resource`);
}

function boundaryCondition(st: PolicyStatement): string | null {
  const cond = (st.raw as { Condition?: HclValue }).Condition;
  if (cond === undefined || typeof cond === "string" || Array.isArray(cond)) {
    return null;
  }
  const arnEquals = (cond as { ArnEquals?: HclValue }).ArnEquals;
  if (arnEquals === undefined || typeof arnEquals !== "object" || Array.isArray(arnEquals)) {
    return null;
  }
  const value = (arnEquals as Record<string, HclValue>)["iam:PermissionsBoundary"];
  return typeof value === "string" ? value : null;
}

/** Does a statement's Effect apply to this exact (action, resource) pair? */
function covers(st: PolicyStatement, action: string, arn: string): boolean {
  return (
    st.actions.some((a) => matchesGlob(a, action)) &&
    resourcesOf(st).some((r) => matchesGlob(r, arn))
  );
}

const CAPPING_ACTIONS = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"];

// Actions that let a role's permissions be rewritten. Used to check the deploy
// role cannot turn them on itself.
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

  it("pins iam:CreateRole to both boundaries", () => {
    expect(sorted(created.keys())).toEqual(sorted(boundaryActions.keys()));
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
      const key = (role.boundaryLocal ?? "").replace(/^local\./, "");
      const declared = locals[key];
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

  it("cannot create a role outside the three stack role names", () => {
    // The pinned patterns are the complete list of roles this pipeline can
    // bring into existence. If one widened to cover, say, every role in the
    // account, the ceiling would still be attached but the blast radius of a
    // compromised deploy would not be the three roles reviewed here.
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
        expect(
          matchesGlob(pattern, roleArn("bbb-mcp-not-a-stack-role")),
          `${boundary} is pinned to ${pattern}, which also matches role ` +
            `names this stack never creates`,
        ).toBe(false);
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

  it("denies removing a boundary from any role it can reach", () => {
    for (const role of roles) {
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
      const allowed = deployStatements.some(
        (st) => st.effect === "Allow" && covers(st, action, self),
      );
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
});
