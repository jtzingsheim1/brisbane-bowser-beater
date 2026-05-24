import type { CycleParams } from "./types";
// The committed artifact is the contract between the Python analysis pipeline
// and this TS code. Importing it directly (rather than fs-reading at runtime)
// lets Next trace and bundle it into the serverless function reliably.
import raw from "../../../analysis/output/cycle_params.json";

const SUPPORTED_SCHEMA_VERSION = 1;

// Light runtime validation. The JSON is version-controlled, but a future re-fit
// (Stage 3, quarterly) could change the schema; fail loudly rather than project
// off a malformed template.
function validate(p: CycleParams): CycleParams {
  if (p.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `cycle_params.json schema_version ${p.schema_version} unsupported (expected ${SUPPORTED_SCHEMA_VERSION})`,
    );
  }
  const { phase, normalised_price, band_std } = p.shape;
  if (
    phase.length < 2 ||
    phase.length !== normalised_price.length ||
    phase.length !== band_std.length
  ) {
    throw new Error("cycle_params.json shape arrays are missing or mismatched");
  }
  if (!(p.params.period_days > 0) || !(p.params.amplitude_dollars > 0)) {
    throw new Error("cycle_params.json has non-positive period or amplitude");
  }
  return p;
}

const cycleParams: CycleParams = validate(raw as CycleParams);

export function getCycleParams(): CycleParams {
  return cycleParams;
}
