"""Cycle characterisation: detrend -> detect troughs/peaks -> per-cycle params
-> canonical shape, with a by-year cross-check on the shape.

Approach (agreed at checkpoints a/b):
  * Detrend with a centered rolling MEDIAN (~55d) to separate the slow
    wholesale/oil baseline from the cycle component.
  * Detect troughs/peaks on the detrended series via scipy.find_peaks,
    gated by prominence (min real swing) and distance (min cycle length).
  * Cycles are trough-to-trough. Per cycle: period, rise/fall days,
    asymmetry, amplitude (on raw price).
  * Canonical shape: min-max normalise each cycle onto a 0..1 phase axis,
    average across cycles. Cross-check by overlaying shapes coloured by year.

All prices in $/L.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.signal import find_peaks

from cycle_lib import daily_average, load_events

OUT = Path(__file__).parent / "output"
OUT.mkdir(exist_ok=True)

# --- Tunable detection parameters (intuitive units) ---
BASELINE_WINDOW_DAYS = 55     # rolling-median window for detrend (~1.5 cycles)
MIN_PROMINENCE = 0.08         # $/L: ignore swings smaller than ~8c
MIN_DISTANCE_DAYS = 18        # cycles can't be closer than this
PHASE_POINTS = 100            # resolution of the normalised cycle shape
MAX_PERIOD_DAYS = 55          # exclusion: longer "cycles" are missed-trough merges


@dataclass(frozen=True)
class Cycle:
    start: pd.Timestamp       # starting trough
    peak: pd.Timestamp
    end: pd.Timestamp         # next trough
    period_days: int
    rise_days: int
    fall_days: int
    amplitude: float          # peak price - mean bounding-trough price ($/L)
    trough_price: float
    peak_price: float


def get_series() -> pd.Series:
    return (daily_average(load_events()) / 1000.0).asfreq("D")


def detrend(s: pd.Series) -> tuple[pd.Series, pd.Series]:
    baseline = s.rolling(BASELINE_WINDOW_DAYS, center=True, min_periods=15).median()
    return s - baseline, baseline


def detect(cycle: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    vals = cycle.to_numpy()
    troughs, _ = find_peaks(-vals, prominence=MIN_PROMINENCE, distance=MIN_DISTANCE_DAYS)
    peaks, _ = find_peaks(vals, prominence=MIN_PROMINENCE, distance=MIN_DISTANCE_DAYS)
    return troughs, peaks


def build_cycles(s: pd.Series, troughs: np.ndarray, peaks: np.ndarray) -> list[Cycle]:
    idx = s.index
    peak_set = list(peaks)
    cycles: list[Cycle] = []
    for a, b in zip(troughs[:-1], troughs[1:]):
        between = [p for p in peak_set if a < p < b]
        if not between:
            continue
        # tallest peak between the two troughs
        pk = max(between, key=lambda p: s.iloc[p])
        t0, tp, t1 = idx[a], idx[pk], idx[b]
        trough_price = (s.iloc[a] + s.iloc[b]) / 2
        cycles.append(
            Cycle(
                start=t0, peak=tp, end=t1,
                period_days=(t1 - t0).days,
                rise_days=(tp - t0).days,
                fall_days=(t1 - tp).days,
                amplitude=s.iloc[pk] - trough_price,
                trough_price=trough_price,
                peak_price=s.iloc[pk],
            )
        )
    return cycles


def select_cycles(cycles: list[Cycle]) -> tuple[list[Cycle], list[Cycle]]:
    """Split detected cycles into (included, excluded) for fitting.

    The single exclusion rule — period > MAX_PERIOD_DAYS, i.e. likely
    missed-trough merges — lives HERE and only here. build_params.py (the
    committed fit) and figures.py (the committed visuals) both use this
    function, so the visuals can never disagree with cycle_params.json about
    which cycles count.
    """
    included = [c for c in cycles if c.period_days <= MAX_PERIOD_DAYS]
    excluded = [c for c in cycles if c.period_days > MAX_PERIOD_DAYS]
    return included, excluded


def normalised_shape(s: pd.Series, c: Cycle) -> np.ndarray:
    seg = s.loc[c.start:c.end].to_numpy()
    if len(seg) < 4:
        return np.full(PHASE_POINTS, np.nan)
    lo, hi = np.nanmin(seg), np.nanmax(seg)
    rng = hi - lo if hi > lo else 1.0
    norm = (seg - lo) / rng
    src_phase = np.linspace(0, 1, len(seg))
    dst_phase = np.linspace(0, 1, PHASE_POINTS)
    return np.interp(dst_phase, src_phase, norm)


def main() -> None:
    s = get_series()
    cyc, baseline = detrend(s)
    troughs, peaks = detect(cyc)
    cycles = build_cycles(s, troughs, peaks)

    # ---- summary stats ----
    periods = np.array([c.period_days for c in cycles])
    amps = np.array([c.amplitude for c in cycles])
    asym = np.array([c.rise_days / c.period_days for c in cycles])
    print(f"Detected {len(cycles)} complete trough-to-trough cycles\n")
    print(f"Period  (days): median {np.median(periods):.0f}  "
          f"mean {periods.mean():.1f}  range {periods.min()}-{periods.max()}")
    print(f"Amplitude ($/L): median {np.median(amps):.3f}  "
          f"mean {amps.mean():.3f}  range {amps.min():.3f}-{amps.max():.3f}")
    print(f"Asymmetry (rise/period): median {np.median(asym):.2f}  "
          f"mean {asym.mean():.2f}  (0.5 = symmetric, <0.5 = faster up)")

    # ---- plot 1: detection check ----
    fig, ax = plt.subplots(2, 1, figsize=(14, 8), sharex=True)
    ax[0].plot(s.index, s.values, lw=0.8, color="#1f77b4", label="daily avg")
    ax[0].plot(baseline.index, baseline.values, lw=1.5, color="orange", label="baseline (rolling median)")
    ax[0].legend(loc="upper right"); ax[0].set_ylabel("$/L"); ax[0].grid(alpha=0.3)
    ax[0].set_title("Raw series + detrend baseline")
    ax[1].plot(cyc.index, cyc.values, lw=0.8, color="gray")
    ax[1].plot(cyc.index[troughs], cyc.values[troughs], "v", color="green", ms=7, label="troughs")
    ax[1].plot(cyc.index[peaks], cyc.values[peaks], "^", color="red", ms=7, label="peaks")
    ax[1].axhline(0, color="black", lw=0.5); ax[1].legend(loc="upper right")
    ax[1].set_ylabel("cycle ($/L)"); ax[1].grid(alpha=0.3)
    ax[1].set_title("Detrended cycle component with detected extrema")
    fig.tight_layout(); fig.savefig(OUT / "fit_detection.png", dpi=110); plt.close(fig)

    # ---- plot 2: per-cycle distributions ----
    fig, ax = plt.subplots(1, 3, figsize=(14, 4))
    ax[0].hist(periods, bins=range(20, 55, 3), color="#1f77b4", edgecolor="white")
    ax[0].set_title("Cycle period (days)"); ax[0].axvline(np.median(periods), color="red", ls="--")
    ax[1].hist(amps, bins=12, color="#2ca02c", edgecolor="white")
    ax[1].set_title("Amplitude ($/L)"); ax[1].axvline(np.median(amps), color="red", ls="--")
    ax[2].hist(asym, bins=12, color="#9467bd", edgecolor="white")
    ax[2].set_title("Asymmetry (rise/period)"); ax[2].axvline(0.5, color="black", ls=":")
    fig.tight_layout(); fig.savefig(OUT / "fit_distributions.png", dpi=110); plt.close(fig)

    # ---- plot 3: canonical shape + by-year cross-check ----
    shapes = np.vstack([normalised_shape(s, c) for c in cycles])
    canonical = np.nanmean(shapes, axis=0)
    phase = np.linspace(0, 1, PHASE_POINTS)
    years = np.array([c.start.year for c in cycles])

    fig, ax = plt.subplots(1, 2, figsize=(14, 5))
    # left: all cycles faint + canonical bold
    for row in shapes:
        ax[0].plot(phase, row, color="gray", alpha=0.25, lw=0.8)
    ax[0].plot(phase, canonical, color="black", lw=2.5, label="canonical (mean)")
    ax[0].set_title(f"All {len(cycles)} cycles + canonical shape")
    ax[0].set_xlabel("cycle phase (0=trough -> 1=next trough)")
    ax[0].set_ylabel("normalised price"); ax[0].legend(); ax[0].grid(alpha=0.3)
    # right: mean shape per year
    cmap = {2023: "#1f77b4", 2024: "#2ca02c", 2025: "#ff7f0e", 2026: "#d62728"}
    print("\nBy-year shape cross-check:")
    for yr in sorted(set(years)):
        ys = shapes[years == yr]
        ym = np.nanmean(ys, axis=0)
        ax[1].plot(phase, ym, color=cmap.get(yr, "gray"), lw=2.2, label=f"{yr} (n={len(ys)})")
        # peak-phase = where the mean shape maxes; a systematic shift would show here
        print(f"  {yr}: n={len(ys):2d}  peak@phase={phase[np.nanargmax(ym)]:.2f}  "
              f"shape-RMS-vs-canonical={np.sqrt(np.nanmean((ym-canonical)**2)):.3f}")
    ax[1].plot(phase, canonical, color="black", lw=1.5, ls="--", label="canonical")
    ax[1].set_title("Mean cycle shape BY YEAR (drift check)")
    ax[1].set_xlabel("cycle phase"); ax[1].set_ylabel("normalised price")
    ax[1].legend(); ax[1].grid(alpha=0.3)
    fig.tight_layout(); fig.savefig(OUT / "fit_canonical.png", dpi=110); plt.close(fig)

    # ---- outlier candidates (checkpoint c preview) ----
    def mad(x): return np.median(np.abs(x - np.median(x)))
    print("\nOutlier candidates (>3.5 MAD on period or amplitude):")
    pmed, pmad = np.median(periods), mad(periods) or 1
    amed, amad = np.median(amps), mad(amps) or 1
    flagged = 0
    for c in cycles:
        pz = abs(c.period_days - pmed) / (1.4826 * pmad)
        az = abs(c.amplitude - amed) / (1.4826 * amad)
        if pz > 3.5 or az > 3.5:
            flagged += 1
            print(f"  {c.start.date()} -> {c.end.date()}: period={c.period_days}d "
                  f"(z={pz:.1f}) amp={c.amplitude:.3f} (z={az:.1f})")
    if not flagged:
        print("  none")

    print(f"\nSaved fit_detection.png, fit_distributions.png, fit_canonical.png to {OUT}")


if __name__ == "__main__":
    main()
