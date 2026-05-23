"""Test whether cycle behaviour is drifting systematically over time.

Motivated by a read of fit_canonical (by-year shapes). Because those shapes are
min-max normalised, they can't speak to amplitude or rise-speed. Here we use the
*un-normalised* per-cycle quantities and regress each against time to separate a
genuine trend from year-to-year noise.

Excludes the single 64-day cycle (likely a missed shallow trough merging two).
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import stats

from cycle_fit import build_cycles, detect, detrend, get_series

OUT = Path(__file__).parent / "output"
MAX_PERIOD_DAYS = 55  # drop the lone 64-day cycle


def main() -> None:
    s = get_series()
    cyc, _ = detrend(s)
    troughs, peaks = detect(cyc)
    cycles = [c for c in build_cycles(s, troughs, peaks) if c.period_days <= MAX_PERIOD_DAYS]
    print(f"Using {len(cycles)} cycles (excluded period > {MAX_PERIOD_DAYS}d)\n")

    # midpoint date as the time axis (ordinal days since first cycle)
    mid = np.array([(c.start + (c.end - c.start) / 2).toordinal() for c in cycles], float)
    t = (mid - mid.min()) / 365.25  # years since first cycle

    metrics = {
        "amplitude ($/L)": np.array([c.amplitude for c in cycles]),
        "rise rate (c/day)": np.array([100 * c.amplitude / c.rise_days for c in cycles]),
        "fall rate (c/day)": np.array([100 * c.amplitude / c.fall_days for c in cycles]),
        "asymmetry (rise/period)": np.array([c.rise_days / c.period_days for c in cycles]),
        "period (days)": np.array([float(c.period_days) for c in cycles]),
    }
    years = np.array([c.start.year for c in cycles])

    print(f"{'metric':<26}{'slope/yr':>10}{'r':>7}{'p':>8}   per-year medians")
    print("-" * 78)
    trends = {}
    for name, vals in metrics.items():
        lr = stats.linregress(t, vals)
        trends[name] = lr
        ymeds = "  ".join(
            f"{yr}:{np.median(vals[years == yr]):.3f}" for yr in sorted(set(years))
        )
        sig = "***" if lr.pvalue < 0.01 else "**" if lr.pvalue < 0.05 else "*" if lr.pvalue < 0.1 else ""
        print(f"{name:<26}{lr.slope:>10.3f}{lr.rvalue:>7.2f}{lr.pvalue:>8.3f}{sig:<3}  {ymeds}")

    # plot scatter + trend per metric
    fig, axes = plt.subplots(1, 5, figsize=(20, 4))
    cmap = {2023: "#1f77b4", 2024: "#2ca02c", 2025: "#ff7f0e", 2026: "#d62728"}
    for ax, (name, vals) in zip(axes, metrics.items()):
        for yr in sorted(set(years)):
            m = years == yr
            ax.scatter(t[m], vals[m], c=cmap.get(yr, "gray"), s=30, label=str(yr))
        lr = trends[name]
        xs = np.array([t.min(), t.max()])
        ax.plot(xs, lr.intercept + lr.slope * xs, "k--", lw=1.5)
        ax.set_title(f"{name}\nslope={lr.slope:.3f}/yr  p={lr.pvalue:.3f}")
        ax.set_xlabel("years since first cycle"); ax.grid(alpha=0.3)
    axes[0].legend(fontsize=8)
    fig.tight_layout(); fig.savefig(OUT / "trend_check.png", dpi=110); plt.close(fig)
    print(f"\nSaved {OUT/'trend_check.png'}")
    print("\n(p<0.05 = trend unlikely to be noise; r = correlation strength)")


if __name__ == "__main__":
    main()
