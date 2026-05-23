"""Finalise the cycle characterisation -> cycle_params.json + validation overlay.

Weighting (decided at checkpoint c):
  * canonical SHAPE and PERIOD: recency-weighted, 12-month half-life, so the
    measured drift (shortening period, steeper decline) pulls the model toward
    current behaviour without discarding older cycles.
  * AMPLITUDE: equal-weighted (it's stable across years; more data = tighter).

cycle_params.json is the committed contract between this notebook and the TS
projection in /lib/forecast/. Schema is documented inline below and mirrored in
lib/forecast/types.ts when chunk 4 lands.
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

from cycle_fit import (
    BASELINE_WINDOW_DAYS,
    MIN_DISTANCE_DAYS,
    MIN_PROMINENCE,
    PHASE_POINTS,
    build_cycles,
    detect,
    detrend,
    get_series,
    normalised_shape,
)

OUT = Path(__file__).parent / "output"
MAX_PERIOD_DAYS = 55
HALF_LIFE_YEARS = 1.0  # recency half-life for shape + period


def recency_weights(cycles) -> np.ndarray:
    mids = np.array(
        [(c.start + (c.end - c.start) / 2).toordinal() for c in cycles], float
    )
    age_years = (mids.max() - mids) / 365.25
    return 0.5 ** (age_years / HALF_LIFE_YEARS)


def main() -> None:
    s = get_series()
    cyc, _ = detrend(s)
    troughs, peaks = detect(cyc)
    all_cycles = build_cycles(s, troughs, peaks)
    cycles = [c for c in all_cycles if c.period_days <= MAX_PERIOD_DAYS]
    w = recency_weights(cycles)

    periods = np.array([c.period_days for c in cycles], float)
    amps = np.array([c.amplitude for c in cycles])
    asym = np.array([c.rise_days / c.period_days for c in cycles])
    shapes = np.vstack([normalised_shape(s, c) for c in cycles])

    def wmean(x):
        return float(np.sum(w * x) / np.sum(w))

    def wstd(x, m):
        return float(np.sqrt(np.sum(w * (x - m) ** 2) / np.sum(w)))

    period_days = wmean(periods)
    asymmetry = wmean(asym)
    amplitude = float(np.mean(amps))            # equal weight
    canonical = (w[:, None] * shapes).sum(0) / w.sum()
    shape_band = np.sqrt((w[:, None] * (shapes - canonical) ** 2).sum(0) / w.sum())
    phase = np.linspace(0, 1, PHASE_POINTS)

    params = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "dataset": "QLD Fuel Price Reporting (data.qld.gov.au), CC BY 4.0",
            "region": "Brisbane core Metro (postcode 4000-4179, QLD)",
            "fuel": "U91 (Unleaded)",
            "span_start": str(s.index.min().date()),
            "span_end": str(s.index.max().date()),
            "n_cycles_used": len(cycles),
            "n_cycles_excluded": len(all_cycles) - len(cycles),
        },
        "method": {
            "detrend": f"centered rolling median, {BASELINE_WINDOW_DAYS}d window",
            "detection": f"scipy find_peaks, prominence={MIN_PROMINENCE} $/L, distance={MIN_DISTANCE_DAYS}d",
            "weighting": f"shape+period recency-weighted ({HALF_LIFE_YEARS:.0f}yr half-life); amplitude equal-weighted",
            "exclusion": f"period > {MAX_PERIOD_DAYS}d (likely missed-trough merges)",
        },
        "params": {
            "period_days": round(period_days, 1),
            "amplitude_dollars": round(amplitude, 4),
            "asymmetry": round(asymmetry, 3),
            "peak_phase": round(asymmetry, 3),
        },
        "uncertainty": {
            "period_days_std": round(wstd(periods, period_days), 1),
            "amplitude_dollars_std": round(float(np.std(amps)), 4),
        },
        "shape": {
            "phase": [round(float(x), 4) for x in phase],
            "normalised_price": [round(float(x), 4) for x in canonical],
            "band_std": [round(float(x), 4) for x in shape_band],
        },
        "drift_notes": (
            "Measured 2023->2025 drift: period shortening ~3 d/yr (p=0.08), "
            "fall rate rising ~0.18 c/day/yr (p=0.04, significant), amplitude "
            "stable (~$0.35, p=0.96). Recency weighting leans the model current. "
            "Re-fit quarterly."
        ),
    }

    out_path = OUT / "cycle_params.json"
    out_path.write_text(json.dumps(params, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"  period   {params['params']['period_days']} d "
          f"(+/- {params['uncertainty']['period_days_std']})")
    print(f"  amplitude ${params['params']['amplitude_dollars']} "
          f"(+/- {params['uncertainty']['amplitude_dollars_std']})")
    print(f"  asymmetry {params['params']['asymmetry']} (peak at "
          f"{params['params']['peak_phase']*100:.0f}% of cycle)")

    # ---- model vs history overlay ----
    # Reconstruct each actual cycle from the canonical shape scaled to that
    # cycle's own trough/peak. Validates that the template captures the shape.
    daily = s
    fig, ax = plt.subplots(figsize=(16, 5))
    ax.plot(daily.index, daily.values, lw=0.9, color="#1f77b4", label="actual daily avg")
    for i, c in enumerate(cycles):
        seg = daily.loc[c.start:c.end]
        ph = np.linspace(0, 1, len(seg))
        model = c.trough_price + (c.peak_price - c.trough_price) * np.interp(
            ph, phase, canonical
        )
        ax.plot(seg.index, model, color="#d62728", lw=1.4,
                label="model (canonical shape)" if i == 0 else None)
    ax.set_title("Model (canonical cycle shape) vs actual Brisbane U91 — 2023–2026")
    ax.set_ylabel("$/L"); ax.legend(loc="upper right"); ax.grid(alpha=0.3)
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b\n%Y"))
    fig.tight_layout(); fig.savefig(OUT / "model_vs_history.png", dpi=110); plt.close(fig)

    # fit quality: RMS error across reconstructed cycles
    errs = []
    for c in cycles:
        seg = daily.loc[c.start:c.end].to_numpy()
        ph = np.linspace(0, 1, len(seg))
        model = c.trough_price + (c.peak_price - c.trough_price) * np.interp(ph, phase, canonical)
        errs.append(np.sqrt(np.nanmean((seg - model) ** 2)))
    print(f"\nShape-fit RMS error: median ${np.median(errs):.3f}/L "
          f"(vs ${amplitude:.3f} amplitude => {np.median(errs)/amplitude*100:.0f}% of swing)")
    print(f"Saved {OUT/'model_vs_history.png'}")


if __name__ == "__main__":
    main()
