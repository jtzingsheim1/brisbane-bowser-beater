"""Download QLD Fuel Price Reporting monthly CSVs into a local cache.

Offline analysis only. Hits the data.qld.gov.au CKAN API to enumerate every
CSV resource in each yearly dataset, then downloads any not already cached.
Files land in analysis/data/ (gitignored) named <year>__<resource_id>.csv so
the irregular 2024 filenames don't collide.

Run:  .venv/Scripts/python.exe download_data.py

Data source: QLD Fuel Price Reporting (data.qld.gov.au), CC BY 4.0.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
CKAN_PKG = "https://www.data.qld.gov.au/api/3/action/package_show?id={}"

# Yearly dataset ids on the QLD open-data portal.
DATASETS = {
    "2023": "387c5ba9-2340-44f4-972f-77f157a6ba52",
    "2024": "c59ba00b-8d2b-4a61-896c-889e0b926d22",
    "2025": "7c07fdce-a5f0-4de0-8213-b8a31575a26d",
    "2026": "0dfad294-f852-45a5-b86f-986773745fe2",
}


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "bbb-analysis/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def csv_resources(dataset_id: str) -> list[dict]:
    payload = fetch_json(CKAN_PKG.format(dataset_id))
    if not payload.get("success"):
        raise RuntimeError(f"CKAN call failed for {dataset_id}")
    resources = payload["result"]["resources"]
    return [r for r in resources if (r.get("format") or "").upper() == "CSV"]


def download(url: str, dest: Path) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": "bbb-analysis/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return len(data)


def main() -> int:
    DATA_DIR.mkdir(exist_ok=True)
    total_files = 0
    total_bytes = 0

    for year, dataset_id in DATASETS.items():
        print(f"\n=== {year} ({dataset_id}) ===")
        try:
            resources = csv_resources(dataset_id)
        except Exception as exc:  # noqa: BLE001 — surface and continue
            print(f"  ! could not enumerate: {exc}")
            continue

        print(f"  {len(resources)} CSV resource(s)")
        for r in resources:
            rid = r["id"]
            url = r["url"]
            dest = DATA_DIR / f"{year}__{rid}.csv"
            if dest.exists() and dest.stat().st_size > 0:
                print(f"  [cached] {r.get('name', rid)}")
                continue
            try:
                size = download(url, dest)
            except Exception as exc:  # noqa: BLE001
                print(f"  [FAILED] {r.get('name', rid)}: {exc}")
                continue
            total_files += 1
            total_bytes += size
            print(f"  [got {size / 1024 / 1024:5.1f} MB] {r.get('name', rid)}")

    cached = list(DATA_DIR.glob("*.csv"))
    print(
        f"\nDownloaded {total_files} new file(s), "
        f"{total_bytes / 1024 / 1024:.1f} MB. "
        f"{len(cached)} CSV(s) cached in {DATA_DIR}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
