# Design — cycle history & model-fit visuals ("show, don't tell")

**Status:** v2 — revised after independent design review · 2026-07-25
**Author:** Claude session (brief from @jtzingsheim1); reviewed by an
independent agent (findings log at the bottom)

## Motivation

Anyone who doesn't already know Brisbane fuel prices are cyclical has to take
the site's word for it — the education section asserts "~39 days, ~35c swing,
asymmetric" in prose. Three years of daily averages show ~20 unmistakable
sawtooth cycles; one glance communicates what three paragraphs currently try
to. The analysis pipeline already *renders* both visuals this design wants
(`explore_plot.py` full history; `cycle_fit.py` plot 3 cycle overlay +
canonical shape) but gitignores them as exploratory diagnostics. This design
promotes polished versions to the public surfaces.

**Audience decision (explicit, from Justin):** the site is read by individual
technical readers who want to see the evidence behind the forecast — *not* a
mass consumer public — and many of them will only ever see the website, never
the GitHub README. Cater to that: both visuals go on the **website**
first-class; the README also gets them (cheap once generated), but the site is
the primary surface. Corollary (from review): such readers often meet the
site as a **link unfurl** first — so the design includes an Open Graph image.

## The two visuals

### V1 — Full-history chart (~36 months, daily Brisbane avg U91)

The "concept lands immediately" chart: ~20 sawtooth cycles over three years.

- **Website:** a small client-side Recharts line chart (consistent styling,
  dark mode, responsive) — *not* a static image.
- **Data:** a new committed artifact `analysis/output/history_daily.json` —
  `[{ d: "YYYY-MM-DD", p: number }]`, daily Brisbane core-Metro U91 average,
  Mar 2023 → end of CSV coverage at generation time. ~1,150+ points ≈ 25–35 KB
  raw (≈ 10–15 KB gzipped). Statically imported; zero runtime data dependency,
  no staleness-gate interaction. Kept **daily** because it's cheap, exact, and
  avoids choosing a downsampling method (at ~0.6 px/day render width, sampling
  isn't what limits legibility — no overclaiming the rationale).
- **Anomaly annotation:** shade the Feb–Apr 2026 window (a Recharts
  `ReferenceArea`) with a one-line caption sourced from `cycle_params.json`
  `anomaly_notes` — "unusual period, excluded from cycle fitting".
- **Two windows, labelled honestly:** the *chart* window ends at CSV coverage;
  the *fit* window ends at `cycle_params.json` `source.span_end` (2026-02-28).
  These are not the same thing. The chart shows all available history with a
  subtle marker at `span_end` ("cycles after this date not yet fitted") —
  turns the discrepancy into a rigour signal. All date labels are derived from
  the data at generation time, never hardcoded.

### V2 — Cycle overlay + canonical shape (the model-fit visual)

All fitted cycles phase-normalised (0 = trough → 1 = next trough), drawn
faint; the canonical shape bold on top. This *is* the forecast model — "not a
formula, just the averaged shape of observed cycles" — and it's the single
best artifact for a technical reader judging the project's rigour.

- **The bold line is read directly from `cycle_params.json`'s committed
  `shape` array** — the *actual* recency-weighted template the forecast
  projects forward. It is **not** recomputed by the figure pipeline. This
  makes the caption "the template the forecast projects forward" true by
  construction — zero drift possible. *(Review finding 1 — the original
  design recomputed an unweighted mean over a longer data window, which is a
  different curve from the committed template.)*
- **Data for the faint rows:** committed `analysis/output/cycle_shapes.json` —
  only the per-cycle normalised shape matrix (the 20 fitted cycles × 60 phase
  points, downsampled from the pipeline's 100) ≈ 25 KB. Generation **pins the
  series to `source.span_end`** before detection and **asserts the detected,
  post-exclusion cycle count equals `n_cycles_used`**, failing loudly on
  mismatch — so the faint rows are provably the same cycles the fit used.
- **Website:** same treatment — small Recharts chart, faint grey series + one
  bold line. Axis labels in plain words: x = "cycle progress — cheapest day →
  next cheapest day", y = "price within cycle (low → high)". Caption: "Every
  regular cycle from the last three years, overlaid (a few irregular stretches
  are excluded — see the shaded band above). The bold line is the
  recency-weighted average shape — the template the forecast projects
  forward."
- **UX/a11y specifics:** no tooltip (it's a shape gestalt, not a lookup
  surface — a default tooltip over 21 series is noise); `isAnimationActive=
  {false}` matching `PriceChart`; `role="img"` + descriptive `aria-label`
  (the caption text) on the wrapper. Same a11y treatment on V1.

### README

Both visuals as committed images under `docs/images/`, **one theme-neutral
image per visual** (mid-grey palette that reads on both GitHub themes) —
halving the polish work vs light/dark pairs; dark variants can come later if
ever worth it. Rendered from the *same committed JSONs* by the figure script,
so the data can't drift (styling is matplotlib vs Recharts and will differ —
accepted, it's the data story that must match). V1 at the top of "The
Brisbane fuel cycle"; V2 in "How the forecast works".

### Open Graph / link previews (new, from review)

`src/app/layout.tsx` currently has title + description only — visitors see
a bare text card when the link unfurls. The figure script emits one extra
1200×630 render of V1 (site-palette, branded caption) wired as the
`openGraph`/`twitter` image. Nearly free given the pipeline, high-leverage
for an audience that meets the site as a link.

## Placement on the page

`CycleEducation` currently sits inside a collapsed `<details>` disclosure —
invisible until clicked. That was right for quiet prose; it buries the
visuals. **Both charts become always-visible** in a compact band under the
main chart's disclosure rows: side-by-side on desktop, stacked on mobile.
V1 proves the phenomenon; V2 proves the engineering — and the engineering is
the strongest part of the story, so it doesn't go back behind a click (review finding 3;
the original design kept V2 in the disclosure, contradicting its own audience
argument). The trimmed prose + ACCC link stay inside the disclosure
(retitled, e.g. "More on how the cycle works").

The "must not compete with the planner for attention" constraint
(`Disclosure.tsx` comment) is honoured by size and palette, not by hiding:
each chart compact (~160–200 px tall), muted colours, no axis clutter, no
animation.

## Data & licence hygiene

- Everything displayed is the **Brisbane-wide daily aggregate** — no
  per-station data anywhere; consistent with the Section-2 cut and LUL 2.2
  irreversible transformation.
- Source is the QLD open-data **CC BY 4.0 CSVs** (not the live LUL feed), so
  the obligation is attribution: caption "Data: QLD Fuel Price Reporting,
  data.qld.gov.au (CC BY 4.0)" linking to `/about/data` on the site; plain
  caption in the README.
- Both new JSONs embed a `source` block (dataset, licence, generated-at,
  span) mirroring `cycle_params.json`'s precedent — they're public derived
  datasets in their own right.
- All captions observation-only per the language discipline; "every regular
  cycle … a few irregular stretches excluded" phrasing avoids overclaiming.

## Pipeline changes

- **Extract the cycle-selection rule** (`MAX_PERIOD_DAYS` exclusion, currently
  inline in `build_params.py main()`) into a shared
  `select_cycles(series) -> (included, excluded)` used by both
  `build_params.py` and the new script — the exclusion logic must not be
  copy-pasted (review finding 2: `cycle_fit.py` alone excludes nothing).
- New `analysis/figures.py`: truncates the series at `span_end` → detects →
  `select_cycles` → asserts count == `n_cycles_used` → emits
  `cycle_shapes.json` (faint rows only) + `history_daily.json` (full CSV
  coverage) + the README images + the OG image. The canonical template is
  never recomputed here — it's read from `cycle_params.json` when rendering.
- Quarterly re-fit runbook gains one step, and `build_params.py` +
  `figures.py` become runnable as **one command**, so a partial refresh
  (params without figures, or vice versa) is hard to do by accident.
- **Environment constraint (verified):** this remote environment's network
  policy blocks `www.data.qld.gov.au`, so the CSV cache cannot be
  re-downloaded in-session. Either the domain is added to the environment's
  network policy, or Justin runs `download_data.py` + the one-command refresh
  locally (as with the May 2026 data refresh) and commits the artifacts.

## Website changes

- New `src/components/CycleHistoryChart.tsx` (client, Recharts) — V1.
- New `src/components/CycleShapeChart.tsx` (client, Recharts) — V2 (bold line
  from `cycle_params.json`, faint rows from `cycle_shapes.json`).
- `CycleEducation.tsx` restructured per Placement; prose paragraph 2 trimmed
  to one sentence with the numbers + estimate framing.
- `src/app/page.tsx` slots the two-chart band; `layout.tsx` gains the OG
  image metadata.
- Bundle impact: ~50–60 KB static JSON raw (~20–30 KB gzipped) + two small
  client components; Recharts is already in the bundle. 21 static 60-point
  series with animation off is ~1,260 points — negligible render cost.

## Architecture: why committed JSON (alternatives considered)

Fetching from Supabase would add a runtime dependency + staleness-gate
coupling to deliberately *static* context — and production Supabase only
holds Jan 2026 onwards anyway. Static images on the site lose dark mode and
responsive text the site already gets via CSS vars. Build-time generation
would put Python on the Vercel path, violating the repo boundary ("Python
never runs on the server"). Committed JSON matches the existing
`cycle_params.json` contract pattern; the maintenance tax of hand-refreshed
artifacts is mitigated by the consistency test below and the one-command
refresh.

## Out of scope

- Extending the history chart to the present by merging live Supabase data
  (the main chart owns "now").
- Interactive exploration (zoom/pan) — static context, per the MVP cut.
- Any per-station rendering.
- Light+dark README image pairs (single theme-neutral image per visual for
  now).

## Verification

- **Cross-artifact consistency test (the one that matters):** a unit test
  asserting (a) `cycle_shapes.json` row count == `cycle_params.json`
  `n_cycles_used`; (b) `history_daily.json` span covers
  `source.span_start → span_end`; (c) both new JSONs carry `source` blocks.
  This is what catches a partial quarterly refresh.
- Schema/loader tests for both JSONs (parse, monotonic dates, value bounds).
- `npm run lint` / `test` / `build` green.
- Visual check of both charts in dev (light + dark); README images on GitHub
  in both themes; link unfurl shows the OG image.

## Housekeeping (separate commit, not part of this design)

- PLAN.md: tip-jar row 🚧 → ✅ live (merged #76/#79, verified in production).

---

## Review log (2026-07-25, independent agent)

Verdict: *"sound with amendments — do not build V2 as specified until
finding 1 is resolved."* All findings adopted:

1. **BLOCKER — V2's bold line ≠ the committed template.** Original design
   recomputed an unweighted mean over a longer data window; the forecast's
   template is the recency-weighted canonical in `cycle_params.json`, fitted
   on data to 2026-02-28. → Bold line now read from `cycle_params.json`;
   faint-row detection pinned to `span_end` with a count assertion.
2. Exclusion rule lives only in `build_params.py`, not `cycle_fit.py`. →
   Extracted to shared `select_cycles()`.
3. Burying V2 in the disclosure contradicted the audience argument. → Both
   charts always-visible.
4. No OG/social image despite link-first audience. → Added.
5. No a11y treatment; 21-series tooltip noise. → `role="img"`/labels, no V2
   tooltip, no animation.
6. Verification missed cross-artifact consistency. → Dedicated test +
   one-command refresh.
7. "Mar 2023 – May 2026" conflated chart window with fit window. → Two
   windows, labels derived at generation, `span_end` marker.
8. Daily-sampling rationale overclaimed. → Reworded honestly.
9. Four polished matplotlib images underestimated. → One theme-neutral image
   per visual.
10. Alternatives-considered missing; artifact count shrinkable. → Section
    added; canonical no longer duplicated into `cycle_shapes.json`.
11. "Every cycle" caption overclaimed (3 excluded + anomaly). → "Every
    regular cycle …" phrasing.
12. New JSONs need embedded `source`/attribution blocks. → Added.
13. PLAN.md housekeeping is unrelated scope. → Moved to separate commit.
