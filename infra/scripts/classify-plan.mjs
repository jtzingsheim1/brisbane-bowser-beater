#!/usr/bin/env node
// Classifies a saved Terraform plan for .github/workflows/mcp-deploy.yml.
//
// Usage: node infra/scripts/classify-plan.mjs plan.json
//   where plan.json is `terraform show -json tfplan`.
//
// Routes:
//   noop     no resource or output changes.
//   routine  every resource change is an in-place update whose changed
//            attributes are all on the per-type allow-list below (the
//            Lambda's code hash and the computed attributes that follow
//            it, and tags_all on the types the update role may tag), or
//            the plan changes outputs only. The unattended update role can
//            apply it.
//   gated    anything else: create, delete, replace, forget, import, move,
//            any other attribute, any other resource type, an errored or
//            incomplete plan. The deploy-gated job applies it after one
//            human approval.
//
// Writes route, corpus_sync and a multiline summary (the printed lines) to
// $GITHUB_OUTPUT when set. Also reports corpus_sync=true when the plan creates or changes the
// knowledge base, its data source, or the stores behind them (beyond
// tags), so the workflow re-ingests the docs corpus only then.
//
// The plan JSON holds prior state, including sensitive values in plain
// text. This script prints addresses, actions and attribute NAMES only,
// never a value, and the workflow never prints the JSON itself. That is an
// accident guard, not a security control: see docs/mcp-auto-deploy-design.md
// section 4.
//
// Plain Node ESM with no dependencies, so it runs on the runner's Node
// without an install step. Pure functions are exported for
// tests/classify-plan.test.ts.

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Attributes whose change alone keeps an update routine, per type.
 *
 * Never add a type that has write-only (ephemeral) attributes: plan JSON
 * shows a write-only attribute as null on both sides, so a change to one
 * is invisible here and would pass as routine.
 */
export const ALLOWED_ATTRIBUTES = {
  aws_lambda_function: [
    "source_code_hash",
    "last_modified",
    "code_sha256",
    "source_code_size",
    "tags_all",
  ],
  // The types the update role may tag (bbb-mcp-update-policy). The data
  // source has no tags; the log group is deliberately absent because the
  // update role holds no logs:TagResource.
  aws_s3_bucket: ["tags_all"],
  aws_s3vectors_vector_bucket: ["tags_all"],
  aws_s3vectors_index: ["tags_all"],
  aws_bedrockagent_knowledge_base: ["tags_all"],
};

/**
 * Attributes allowed only as unknown-after-apply churn (the provider
 * recomputes them when the code changes). A known new value for any of
 * them is a real change and gates the plan.
 */
export const UNKNOWN_ONLY_ATTRIBUTES = {
  aws_lambda_function: ["qualified_arn", "qualified_invoke_arn", "version"],
};

/** Resource types whose non-tag changes call for a corpus re-ingestion. */
export const CORPUS_TYPES = [
  "aws_bedrockagent_knowledge_base",
  "aws_bedrockagent_data_source",
  "aws_s3_bucket",
  "aws_s3vectors_vector_bucket",
  "aws_s3vectors_index",
];

const isObject = (v) => v !== null && typeof v === "object";

/** Structural equality for JSON values. */
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** True when an after_unknown entry marks anything inside it unknown. */
export function containsUnknown(v) {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(containsUnknown);
  if (isObject(v)) return Object.values(v).some(containsUnknown);
  return false;
}

/**
 * Top-level attribute names an update changes: a different known value,
 * or a value that becomes unknown until apply. Names only.
 */
export function changedAttributes(change) {
  const before = isObject(change?.before) ? change.before : {};
  const after = isObject(change?.after) ? change.after : {};
  const unknown = isObject(change?.after_unknown) ? change.after_unknown : {};
  const keys = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
    ...Object.keys(unknown),
  ]);
  const changed = [];
  for (const k of keys) {
    if (containsUnknown(unknown[k]) || !jsonEqual(before[k], after[k])) {
      changed.push(k);
    }
  }
  return changed.sort();
}

/** True when attribute k is unknown after apply and has no known value. */
function unknownOnly(change, k) {
  const after = isObject(change?.after) ? change.after : {};
  const unknown = isObject(change?.after_unknown) ? change.after_unknown : {};
  return containsUnknown(unknown[k]) && after[k] === undefined;
}

/**
 * Classifies one resource_changes entry.
 * Returns null for entries that need no report (no-op, data reads),
 * otherwise { address, actions, verdict: "routine" | "gated", reason,
 * corpus }.
 */
export function classifyResourceChange(rc) {
  const address = String(rc?.address ?? "(unknown address)");
  const type = String(rc?.type ?? "");
  const change = rc?.change ?? {};
  const actions = Array.isArray(change.actions) ? change.actions.map(String) : [];
  const base = { address, actions, corpus: false };

  if (change.importing) {
    return { ...base, verdict: "gated", reason: "import" };
  }
  // A move (a `moved` block or a refactor) is gated whatever else the
  // entry does, so it is checked before any action: an update that also
  // moves must not pass as a routine update.
  if (rc?.previous_address) {
    const writes = actions.some((a) => a === "create" || a === "update");
    return { ...base, verdict: "gated", reason: "moved", corpus: CORPUS_TYPES.includes(type) && writes };
  }
  if (actions.length === 1 && actions[0] === "no-op") return null;
  // Data sources read at apply time change nothing in AWS.
  if (actions.length === 1 && actions[0] === "read") return null;

  const corpusType = CORPUS_TYPES.includes(type);
  const removesOnly = actions.every((a) => a === "delete" || a === "forget");

  if (actions.length !== 1 || actions[0] !== "update") {
    return {
      ...base,
      verdict: "gated",
      reason: actions.length > 1 ? "replace" : actions.join("+") || "no actions",
      corpus: corpusType && !removesOnly,
    };
  }

  const changed = changedAttributes(change);
  const corpus = corpusType && changed.some((k) => k !== "tags_all");
  if (changed.length === 0) {
    return { ...base, verdict: "gated", reason: "update with no visible attribute change", corpus };
  }
  const allowed = ALLOWED_ATTRIBUTES[type] ?? [];
  const churn = UNKNOWN_ONLY_ATTRIBUTES[type] ?? [];
  const outside = changed.filter(
    (k) => !allowed.includes(k) && !(churn.includes(k) && unknownOnly(change, k)),
  );
  if (outside.length > 0) {
    return { ...base, verdict: "gated", reason: `changes ${outside.join(", ")}`, corpus };
  }
  return { ...base, verdict: "routine", reason: `changes ${changed.join(", ")}`, corpus };
}

/** Classifies a whole plan. Returns { route, corpusSync, entries, notes }. */
export function classifyPlan(plan) {
  const entries = [];
  const notes = [];
  let gated = false;

  if (!isObject(plan)) throw new Error("plan JSON is not an object");
  if (plan.errored === true) {
    gated = true;
    notes.push("plan is marked errored");
  }
  if (plan.complete === false) {
    gated = true;
    notes.push("plan is incomplete (deferred changes)");
  }

  for (const rc of plan.resource_changes ?? []) {
    const entry = classifyResourceChange(rc);
    if (!entry) continue;
    entries.push(entry);
    if (entry.verdict === "gated") gated = true;
  }

  // Output-only changes write state and nothing else: routine.
  for (const [name, change] of Object.entries(plan.output_changes ?? {})) {
    const actions = Array.isArray(change?.actions) ? change.actions.map(String) : [];
    if (actions.length === 1 && actions[0] === "no-op") continue;
    entries.push({
      address: `output.${name}`,
      actions,
      verdict: "routine",
      reason: "output",
      corpus: false,
    });
  }

  const route = gated ? "gated" : entries.length === 0 ? "noop" : "routine";
  return { route, corpusSync: entries.some((e) => e.corpus), entries, notes };
}

/** Human-readable lines: addresses, actions and attribute names only. */
export function formatLines(result) {
  const lines = result.entries.map(
    (e) => `${e.verdict.padEnd(7)}  ${e.address}  [${e.actions.join(", ")}]  ${e.reason}`,
  );
  for (const n of result.notes) lines.push(`gated    (plan)  ${n}`);
  lines.push(`route=${result.route} corpus_sync=${result.corpusSync}`);
  return lines;
}

export function formatSummary(result, title = "Terraform plan classification") {
  const body = formatLines(result).join("\n");
  return `### ${title}\n\nRoute: **${result.route}**\n\n\`\`\`text\n${body}\n\`\`\`\n`;
}

/**
 * $GITHUB_OUTPUT content: route, corpus_sync, and `summary` (the same
 * lines as stdout, multiline, so the workflow can put them in the
 * mcp-deploy issue; the REST API does not serve job summaries).
 */
export function formatOutputs(result, delimiter = `CLASSIFY_${randomUUID()}`) {
  const lines = formatLines(result);
  if (lines.some((l) => l.includes(delimiter))) {
    throw new Error("output delimiter collides with the summary");
  }
  return (
    `route=${result.route}\ncorpus_sync=${result.corpusSync}\n` +
    `summary<<${delimiter}\n${lines.join("\n")}\n${delimiter}\n`
  );
}

function main(argv) {
  const path = argv[2];
  if (!path) {
    console.error("usage: classify-plan.mjs <plan.json>");
    process.exit(2);
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A parse error message quotes the input around the fault, and the
    // input holds prior state with sensitive values: print nothing of it.
    console.error("plan JSON did not parse");
    process.exit(1);
  }
  const result = classifyPlan(plan);
  for (const line of formatLines(result)) console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, formatOutputs(result));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      formatSummary(result, process.env.CLASSIFY_TITLE || undefined),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
