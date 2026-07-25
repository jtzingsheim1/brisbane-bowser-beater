"""Emit the committed public visuals and their data artifacts.

Outputs (all committed to git, refreshed alongside each quarterly re-fit):

  analysis/output/history_daily.json   full-coverage daily Brisbane avg series
  analysis/output/cycle_shapes.json    per-cycle normalised shapes (faint rows)
  docs/images/cycle-history.png        README: ~3yr history (theme-neutral)
  docs/images/cycle-overlay.png        README: overlay + canonical template
  src/app/opengraph-image.png          1200x630 link-preview card

The canonical template is NEVER recomputed here. The bold line in the overlay
(and on the website) is read from cycle_params.json's committed `shape` — the
actual recency-weighted template the forecast projects forward. This script
only regenerates the faint per-cycle rows, with the series PINNED to the
committed fit's span and the detected cycle set ASSERTED to match
n_cycles_used / n_cycles_excluded, so the visuals can never drift from the
fit they claim to illustrate.

Run (after download_data.py):  .venv/bin/python figures.py
Quarterly re-fit:              .venv/bin/python refresh_all.py

history_daily.json schema (mirrored in src/lib/history/types.ts):
  { schema_version: 1, generated_at: iso, source: {...}, days: [{d, p}] }
  d = "YYYY-MM-DD", p = $/L (4 dp). Full CSV coverage, not just the fit span.

cycle_shapes.json schema (mirrored in src/lib/history/types.ts):
  { schema_version: 1, generated_at: iso, source: {...},
    phase: [...],                      # cycle_params.json's exact phase grid
    cycles: [{start, end, period_days, shape: [...]}] }
  shape values are min-max normalised prices on the shared phase grid.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from cycle_fit import (
    build_cycles,
    detect,
    detrend,
    get_series,
    normalised_shape,
    select_cycles,
)

ROOT = Path(__file__).parent.parent
OUT = Path(__file__).parent / "output"
IMAGES = ROOT / "docs" / "images"
OG_PATH = ROOT / "src" / "app" / "opengraph-image.png"

# Theme-neutral palette: legible on both GitHub light and dark backgrounds.
LINE = "#4f83cc"      # muted blue — the price series / bold template
FAINT = "#9ca3af"     # grey — faint per-cycle rows, axes, labels
ANOMALY = "#d97706"   # amber — anomaly window shading
TEXT = "#6b7280"      # mid-grey text: readable on white and near-black


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def style_axes(ax) -> None:
    """Transparent, quiet axes that read on light and dark."""
    ax.set_facecolor("none")
    for spine in ax.spines.values():
        spine.set_color(FAINT)
        spine.set_alpha(0.5)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(colors=TEXT, labelsize=9)
    ax.grid(alpha=0.18, color=FAINT)
    ax.title.set_color(TEXT)
    ax.xaxis.label.set_color(TEXT)
    ax.yaxis.label.set_color(TEXT)


def main() -> None:
    params = json.loads((OUT / "cycle_params.json").read_text(encoding="utf-8"))
    src = params["source"]
    fit_start, fit_end = src["span_start"], src["span_end"]
    anomaly = params.get("anomaly_notes", {}).get("window")

    s_full = get_series().dropna()

    # ---- pin the faint-cycle detection to the committed fit's span ----
    s_fit = s_full.loc[fit_start:fit_end]
    cyc, _ = detrend(s_fit)
    troughs, peaks = detect(cyc)
    included, excluded = select_cycles(build_cycles(s_fit, troughs, peaks))
    if len(included) != src["n_cycles_used"] or len(excluded) != src["n_cycles_excluded"]:
        raise SystemExit(
            f"Cycle set mismatch vs committed fit: detected "
            f"{len(included)} used / {len(excluded)} excluded, but "
            f"cycle_params.json says {src['n_cycles_used']} / "
            f"{src['n_cycles_excluded']}. The upstream CSVs may have been "
            f"revised, or detection parameters changed — do NOT commit these "
            f"artifacts; re-run the full quarterly re-fit instead."
        )

    phase = np.array(params["shape"]["phase"])
    canonical = np.array(params["shape"]["normalised_price"])
    shapes = np.vstack([normalised_shape(s_fit, c) for c in included])

    # ---- history_daily.json (full coverage, not just the fit span) ----
    history = {
        "schema_version": 1,
        "generated_at": now_iso(),
        "source": {
            "dataset": src["dataset"],
            "region": src["region"],
            "fuel": src["fuel"],
            "span_start": str(s_full.index.min().date()),
            "span_end": str(s_full.index.max().date()),
            "fit_span_end": fit_end,
        },
        "days": [
            {"d": str(day.date()), "p": round(float(p), 4)}
            for day, p in s_full.items()
        ],
    }
    (OUT / "history_daily.json").write_text(
        json.dumps(history, separators=(",", ":")) + "\n", encoding="utf-8"
    )

    # ---- cycle_shapes.json (faint rows on the canonical's exact grid) ----
    # Full 100-point grid rather than a downsample: sharing cycle_params.json's
    # phase array lets the site put faint rows and the bold template in one
    # data array with zero interpolation (size difference is negligible gzipped).
    shapes_doc = {
        "schema_version": 1,
        "generated_at": now_iso(),
        "source": {
            "dataset": src["dataset"],
            "region": src["region"],
            "fuel": src["fuel"],
            "fit_span_start": fit_start,
            "fit_span_end": fit_end,
            "n_cycles": len(included),
            "exclusion": params["method"]["exclusion"],
        },
        "phase": params["shape"]["phase"],
        "cycles": [
            {
                "start": str(c.start.date()),
                "end": str(c.end.date()),
                "period_days": c.period_days,
                "shape": [round(float(x), 4) for x in row],
            }
            for c, row in zip(included, shapes)
        ],
    }
    (OUT / "cycle_shapes.json").write_text(
        json.dumps(shapes_doc, separators=(",", ":")) + "\n", encoding="utf-8"
    )

    IMAGES.mkdir(parents=True, exist_ok=True)

    # ---- README image 1: full history ----
    fig, ax = plt.subplots(figsize=(14, 4.2))
    fig.patch.set_alpha(0.0)
    ax.plot(s_full.index, s_full.values, lw=1.0, color=LINE)
    if anomaly:
        ax.axvspan(
            pd.Timestamp(anomaly["start"]), pd.Timestamp(anomaly["end"]),
            color=ANOMALY, alpha=0.13,
        )
        ax.text(
            pd.Timestamp(anomaly["start"]) + (pd.Timestamp(anomaly["end"]) - pd.Timestamp(anomaly["start"])) / 2,
            float(np.nanmin(s_full.values)),
            "unusual period —\nexcluded from cycle fitting",
            ha="center", va="bottom", fontsize=8, color=TEXT,
        )
    ax.axvline(pd.Timestamp(fit_end), color=FAINT, lw=1.0, ls="--", alpha=0.7)
    ax.text(
        pd.Timestamp(fit_end), float(np.nanmax(s_full.values)),
        "cycles after this date\nnot yet fitted ",
        ha="right", va="top", fontsize=8, color=TEXT,
    )
    ax.set_ylabel("Brisbane avg U91  ($/L)")
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b\n%Y"))
    style_axes(ax)
    fig.tight_layout()
    fig.savefig(IMAGES / "cycle-history.png", dpi=150, transparent=True)
    plt.close(fig)

    # ---- README image 2: overlay + canonical template ----
    fig, ax = plt.subplots(figsize=(9, 5))
    fig.patch.set_alpha(0.0)
    for row in shapes:
        ax.plot(phase, row, color=FAINT, alpha=0.32, lw=1.0)
    ax.plot(
        phase, canonical, color=LINE, lw=2.8,
        label="canonical shape (recency-weighted) — the forecast template",
    )
    ax.set_xlabel("cycle progress  (cheapest day → next cheapest day)")
    ax.set_ylabel("price within cycle  (low → high)")
    leg = ax.legend(loc="upper right", fontsize=9, frameon=False)
    for t in leg.get_texts():
        t.set_color(TEXT)
    style_axes(ax)
    fig.tight_layout()
    fig.savefig(IMAGES / "cycle-overlay.png", dpi=150, transparent=True)
    plt.close(fig)

    # ---- Open Graph card (fixed dark look — unfurls have no theme) ----
    fig = plt.figure(figsize=(12, 6.3), dpi=100)
    fig.patch.set_facecolor("#101318")
    ax = fig.add_axes([0.07, 0.12, 0.86, 0.52])
    ax.set_facecolor("none")
    ax.plot(s_full.index, s_full.values, lw=1.3, color="#7aa7e8")
    ax.axis("off")
    fig.text(
        0.07, 0.86, "Brisbane Bowser Beater",
        fontsize=30, fontweight="bold", color="#f4f4f5", ha="left",
    )
    fig.text(
        0.07, 0.775,
        "Three years of Brisbane fuel price cycles — charted, forecast, and timed.",
        fontsize=15, color="#a1a1aa", ha="left",
    )
    fig.text(
        0.07, 0.045,
        "Data: QLD Fuel Price Reporting, data.qld.gov.au (CC BY 4.0)",
        fontsize=10, color="#71717a", ha="left",
    )
    fig.savefig(OG_PATH, dpi=100, facecolor=fig.get_facecolor())
    plt.close(fig)

    print(f"history_daily.json  {len(history['days'])} days "
          f"({history['source']['span_start']} -> {history['source']['span_end']})")
    print(f"cycle_shapes.json   {len(shapes_doc['cycles'])} cycles, "
          f"{len(shapes_doc['phase'])} phase points (grid shared with cycle_params.json)")
    print(f"images              {IMAGES / 'cycle-history.png'}")
    print(f"                    {IMAGES / 'cycle-overlay.png'}")
    print(f"                    {OG_PATH}")


if __name__ == "__main__":
    main()
