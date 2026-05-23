"""Checkpoint (a) exploration plots: the Brisbane U91 daily-average series.

Renders the full 2023->2026 series and a recent zoom so we can eyeball the
cycle shape, count cycles, and judge regime drift across years.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

from cycle_lib import daily_average, load_events

OUT = Path(__file__).parent / "output"
OUT.mkdir(exist_ok=True)


def main() -> None:
    daily = daily_average(load_events()) / 1000.0  # tenths-of-cent -> $/L

    # --- Full series ---
    fig, ax = plt.subplots(figsize=(14, 5))
    ax.plot(daily.index, daily.values, lw=0.9, color="#1f77b4")
    ax.set_title("Brisbane core-Metro U91 daily average (carry-forward), 2023–2026")
    ax.set_ylabel("$ / L")
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b\n%Y"))
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(OUT / "explore_full.png", dpi=110)
    plt.close(fig)

    # --- Recent ~150 days zoom ---
    recent = daily.iloc[-150:]
    fig, ax = plt.subplots(figsize=(14, 5))
    ax.plot(recent.index, recent.values, lw=1.4, color="#d62728", marker=".", ms=3)
    ax.set_title("Recent ~150 days — cycle shape detail")
    ax.set_ylabel("$ / L")
    ax.xaxis.set_major_locator(mdates.WeekdayLocator(byweekday=mdates.MO, interval=2))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
    ax.grid(True, alpha=0.3)
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(OUT / "explore_recent.png", dpi=110)
    plt.close(fig)

    # --- Per-year quick stats to quantify regime drift ---
    print("Year   n     mean    min     max     std")
    for yr, grp in daily.groupby(daily.index.year):
        print(f"{yr}  {len(grp):4d}  {grp.mean():.3f}  {grp.min():.3f}  "
              f"{grp.max():.3f}  {grp.std():.3f}")

    print(f"\nSaved {OUT/'explore_full.png'}")
    print(f"Saved {OUT/'explore_recent.png'}")


if __name__ == "__main__":
    main()
