"""Load QLD fuel CSVs and build the Brisbane U91 daily-average series.

The daily series replicates the production aggregate exactly (see
supabase migration 0006, brisbane_daily_avg_u91):

  * region:   state == 'QLD' AND postcode in [4000, 4179]  (core Brisbane Metro)
  * fuel:     Fuel_Type == 'Unleaded'  (QLD's label for U91)
  * per day:  each station's most-recent *standing* price as of that day
              (carry-forward), then the cross-station mean.

Keeping this identical to production means the cycle we characterise is the
same series the chart and forecast operate on.

Data source: QLD Fuel Price Reporting (data.qld.gov.au), CC BY 4.0.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).parent / "data"

POSTCODE_MIN = 4000
POSTCODE_MAX = 4179
STATE = "QLD"
FUEL = "Unleaded"

# Columns we need from the changes-only CSVs (each row is a price-change event,
# carrying its station's attributes).
COLS = {
    "SiteId": "site_id",
    "Site_Post_Code": "postcode",
    "Site_State": "state",
    "Fuel_Type": "fuel",
    "Price": "price",
    "TransactionDateutc": "ts",
}


def _read_one(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, encoding="utf-8-sig", on_bad_lines="skip")
    # Normalise header whitespace, then keep only the columns we know.
    df.columns = [c.strip() for c in df.columns]
    present = {src: dst for src, dst in COLS.items() if src in df.columns}
    missing = set(COLS) - set(present)
    if missing:
        raise ValueError(f"{path.name}: missing columns {sorted(missing)}")
    return df[list(present)].rename(columns=present)


def load_events(data_dir: Path = DATA_DIR) -> pd.DataFrame:
    """Load all cached CSVs, filter to Brisbane-core U91 events, typed."""
    files = sorted(data_dir.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"No CSVs in {data_dir}. Run download_data.py first.")

    frames = [_read_one(f) for f in files]
    raw = pd.concat(frames, ignore_index=True)

    raw["state"] = raw["state"].str.strip().str.upper()
    raw["fuel"] = raw["fuel"].str.strip()
    raw["postcode_num"] = pd.to_numeric(raw["postcode"], errors="coerce")
    raw["price"] = pd.to_numeric(raw["price"], errors="coerce")
    raw["site_id"] = pd.to_numeric(raw["site_id"], errors="coerce")
    raw["ts"] = pd.to_datetime(raw["ts"], dayfirst=True, errors="coerce")

    mask = (
        (raw["state"] == STATE)
        & (raw["fuel"] == FUEL)
        & raw["postcode_num"].between(POSTCODE_MIN, POSTCODE_MAX)
        & raw["price"].notna()
        & raw["ts"].notna()
        & raw["site_id"].notna()
    )
    events = raw.loc[mask, ["site_id", "ts", "price"]].copy()

    # QLD prices are in cents; some files use cents, confirm by magnitude later.
    events = events.drop_duplicates(subset=["site_id", "ts"]).sort_values("ts")
    return events.reset_index(drop=True)


def daily_average(events: pd.DataFrame) -> pd.Series:
    """Carry-forward cross-station daily mean standing price.

    For each station, take its last price each day, forward-fill across days it
    didn't change, then average across stations per day. A station contributes
    only from its first observed price onward (no back-fill).
    """
    ev = events.copy()
    ev["day"] = ev["ts"].dt.normalize()
    # Last standing price per station per day.
    last = ev.sort_values("ts").groupby(["site_id", "day"])["price"].last()
    wide = last.unstack("site_id")  # rows = days, cols = stations

    full_days = pd.date_range(wide.index.min(), wide.index.max(), freq="D")
    wide = wide.reindex(full_days)
    wide = wide.ffill()  # carry each station's standing price forward
    return wide.mean(axis=1).rename("avg_u91")


if __name__ == "__main__":
    ev = load_events()
    span = (ev["ts"].min(), ev["ts"].max())
    print(f"Brisbane-core U91 events: {len(ev):,}")
    print(f"Distinct stations:        {ev['site_id'].nunique():,}")
    print(f"Time span:                {span[0].date()} -> {span[1].date()}")
    print(f"Price magnitude sample:   {ev['price'].head(3).tolist()} "
          f"(median {ev['price'].median():.1f})")

    daily = daily_average(ev)
    print(f"\nDaily series points:      {len(daily):,}")
    print(f"Daily range:              {daily.min():.1f} - {daily.max():.1f}")
    print(daily.describe().round(1).to_string())
