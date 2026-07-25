# Design — cycle history & model-fit visuals ("show, don't tell")

**Status:** draft for review · 2026-07-25
**Author:** Claude session (brief from @jtzingsheim1)

## Motivation

Anyone who doesn't already know Brisbane fuel prices are cyclical has to take
the site's word for it — the education section asserts "~39 days, ~35c swing,
asymmetric" in prose. Three years of daily averages show ~20 unmistakable
sawtooth cycles; one glance communicates what three paragraphs currently try
to. The analysis pipeline already *renders* both visuals this design wants
(`explore_plot.py` full history; `cycle_fit.py` plot 3 cycle overlay +
canonical shape) but gitignores them as exploratory diagnostics. This design
promotes polished versions to the public surfaces.

**Audience decision (explicit, from Justin):** the website's real audience is
Justin plus occasional recruiters/technical evaluators — *not* a mass consumer
public, and many evaluators will only ever see the website, never the GitHub
README. Cater to the actual audience: both visuals go on the **website**
first-class; the README also gets them (cheap once generated), but the site is
the primary surface.

## The two visuals

### V1 — Full-history chart (~36 months, daily Brisbane avg U91)

The "concept lands immediately" chart: ~20 sawtooth cycles over three years.

- **Website:** a small client-side Recharts line chart (consistent styling,
  dark mode, responsive) — *not* a static image.
- **Data:** a new committed artifact `analysis/output/history_daily.json` —
  `[{ d: "YYYY-MM-DD", p: number }]`, daily Brisbane core-Metro U91 average,
  Mar 2023 → end of CSV coverage (May 2026). ~1,150 points ≈ 25–35 KB.
  Statically imported; zero runtime data dependency, no staleness-gate
  interaction. **Daily, not downsampled** — at ~39-day periods, weekly
  sampling would blunt the sawtooth asymmetry that is the whole point.
- **Anomaly annotation:** shade the Feb–Apr 2026 window (a Recharts
  `ReferenceArea`) with a one-line caption sourced from `cycle_params.json`
  `anomaly_notes` — "unusual period, excluded from cycle fitting". Honest and
  it reads as rigour.
- **Coverage end / growing gap:** the chart deliberately ends at the analysis
  window (labelled "Mar 2023 – May 2026"); the main chart above it owns the
  present. Refreshed at each quarterly re-fit along with `cycle_params.json`.

### V2 — Cycle overlay + canonical shape (the model-fit visual)

All detected cycles phase-normalised (0 = trough → 1 = next trough), drawn
faint; the canonical (mean) shape bold on top. This *is* the forecast model —
"not a formula, just the averaged shape of observed cycles" — and it's the
single best artifact for a technical evaluator judging the project's rigour.

- **Website:** same treatment — small Recharts chart, faint grey series + one
  bold line. Axis labels in plain words, not analyst-speak: x = "cycle
  progress — cheapest day → next cheapest day", y = "price within cycle (low →
  high)". Caption: "Every cycle from the last three years, overlaid. The bold
  line is the average shape — the template the forecast projects forward."
- **Data:** committed `analysis/output/cycle_shapes.json` — the per-cycle
  normalised shape matrix + canonical mean. 20 cycles × 60 phase points
  (downsampled from the pipeline's 100 — visually identical at render size)
  ≈ 25 KB. Outlier/anomaly cycles excluded exactly as the fit excludes them,
  so the visual and `cycle_params.json` never disagree.

### README

Both visuals as committed images under `docs/images/` (precedent:
`docs/workflow.svg`): light + dark variants served via GitHub's
`<picture>`/`prefers-color-scheme` pattern. V1 at the top of "The Brisbane
fuel cycle"; V2 in "How the forecast works". Rendered by the same Python
script that emits the JSONs, so site and README can't drift apart.

## Placement on the page (decision point)

`CycleEducation` currently sits inside a collapsed `<details>` disclosure —
invisible until clicked. That was right for quiet prose; it buries the
visuals. **Proposal:** V1 (full history) becomes *always-visible* directly
under the main chart's disclosure row — it replaces most of the current
second paragraph of education copy (the numbers become visible rather than
asserted). V2 + the remaining trimmed prose stay inside the disclosure
(retitled, e.g. "How the cycle works — and how we model it"). This honours
the original product spec ("static educational copy below the chart — always
visible") better than the current implementation does, while keeping the
page's visual hierarchy: main chart → narrative → history context → planner.

Note the "must not compete with the planner for attention" constraint on the
disclosure block (`Disclosure.tsx` comment): V1 always-visible should be
compact (~160–200 px tall), muted palette, no axis clutter.

## Data & licence hygiene

- Everything displayed is the **Brisbane-wide daily aggregate** — no
  per-station data anywhere; consistent with the Section-2 cut and LUL 2.2
  irreversible transformation.
- Source is the QLD open-data **CC BY 4.0 CSVs** (not the live LUL feed), so
  the obligation is attribution: caption "Data: QLD Fuel Price Reporting,
  data.qld.gov.au (CC BY 4.0)" linking to `/about/data` on the site; plain
  caption in the README.
- All captions observation-only per the language discipline (the charts
  themselves are inherently observational — let the data speak).

## Pipeline changes

- New `analysis/figures.py`: loads the cached CSVs via the existing
  `cycle_lib`/`cycle_fit` machinery, emits the two committed JSONs + the four
  README images. Diagnostic PNGs stay gitignored; committed outputs are
  explicit exceptions.
- `analysis/output/history_daily.json` + `cycle_shapes.json` join
  `cycle_params.json` as committed Python↔TS contracts; schema documented
  inline in `figures.py` and mirrored in a small TS type.
- Quarterly re-fit runbook (CLAUDE.md forecast section + `analysis` docs)
  gains one line: rerun `figures.py`, recommit artifacts.
- CSV cache is re-downloadable in-session via `download_data.py` (public
  CKAN, no token).

## Website changes

- New `src/components/CycleHistoryChart.tsx` (client, Recharts) — V1.
- New `src/components/CycleShapeChart.tsx` (client, Recharts) — V2.
- `CycleEducation.tsx` restructured per Placement above; prose paragraph 2
  trimmed to one sentence with the numbers + estimate framing.
- `src/app/page.tsx` slots V1 between the disclosure rows and the planner
  section (exact position per Placement).
- Bundle impact: ~50–60 KB of static JSON + two small client components;
  Recharts is already in the bundle for the main chart.

## Out of scope

- Extending the history chart to the present by merging live Supabase data
  (scope creep; the main chart owns "now").
- Interactive exploration (zoom/pan) — static context, per the MVP cut
  ("interactive historical charts — out").
- Any per-station rendering.

## Verification

- Unit: schema/loader test for both JSONs (parse, monotonic dates, value
  bounds); snapshot-free component smoke tests if cheap.
- `npm run lint` / `test` / `build` green.
- Visual check of both charts in dev (light + dark).
- README images render on GitHub in both themes.

## Also folded in (housekeeping)

- PLAN.md: tip-jar row 🚧 → ✅ live (merged #76/#79, verified in production).
