// Server-level checks that don't need the Lambda plumbing: the language
// discipline the project applies to every public surface (see CLAUDE.md
// "Legal hygiene") and the curated cycle-model payload.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cycleParams from "../../analysis/output/cycle_params.json" with { type: "json" };
import { getCycleModel } from "./cycle-model.js";
// Observation-only wording: none of the listed terms may appear in any
// user-visible string this server ships (tool descriptions, instructions,
// outputs). The list lives in banned-language.ts so the corpus-manifest
// test can apply the same sweep to every doc the RAG tools serve.
import { BANNED_LANGUAGE } from "./banned-language.js";

describe("language discipline", () => {
  it("keeps banned framing out of the server source", () => {
    const source = ["server.ts", "cycle-model.ts", "data.ts", "handler.ts", "rag.ts"]
      .map((f) =>
        readFileSync(
          fileURLToPath(new URL(`./${f}`, import.meta.url)),
          "utf-8",
        ).toLowerCase(),
      )
      .join("\n");
    for (const banned of BANNED_LANGUAGE) {
      expect(source, `banned term "${banned}"`).not.toContain(banned);
    }
  });

  it("keeps banned framing out of the committed cycle params", () => {
    const text = JSON.stringify(cycleParams).toLowerCase();
    for (const banned of BANNED_LANGUAGE) {
      expect(text, `banned term "${banned}"`).not.toContain(banned);
    }
  });
});

describe("cycle model payload", () => {
  it("mirrors the committed characterisation", () => {
    const model = getCycleModel(false);
    expect(model.params).toEqual(cycleParams.params);
    expect(model.uncertainty).toEqual(cycleParams.uncertainty);
    expect(model.source).toEqual(cycleParams.source);
    expect(model.drift_notes).toBe(cycleParams.drift_notes);
    expect(model.anomaly_notes.window).toEqual(cycleParams.anomaly_notes.window);
  });

  it("omits internal modelling rationale fields", () => {
    const model = getCycleModel(true) as unknown as Record<string, unknown>;
    const anomaly = model.anomaly_notes as Record<string, unknown>;
    expect(anomaly.rationale_for_no_refit).toBeUndefined();
    expect(anomaly.post_anomaly_anchor_rationale).toBeUndefined();
    expect(model.post_anomaly_anchor_date).toBeUndefined();
  });

  it("returns the shape only on request, matching the committed grid", () => {
    expect(getCycleModel(false).shape).toBeUndefined();
    const withShape = getCycleModel(true);
    expect(withShape.shape?.phase).toEqual(cycleParams.shape.phase);
    expect(withShape.shape?.normalised_price).toEqual(
      cycleParams.shape.normalised_price,
    );
  });
});
