"""Quarterly re-fit, one command: params + all committed visuals together.

Running the pieces separately risks a partial refresh (params without
figures, or vice versa) — the cross-artifact consistency test in
src/lib/history/artifacts.test.ts fails the build on that, but this script
makes it hard to get wrong in the first place.

Run:  .venv/bin/python refresh_all.py     (after download_data.py)
"""

from __future__ import annotations

import build_params
import figures

REMINDER = """
================================================================================
REMINDER — manual step before committing:

build_params.py does NOT emit `anomaly_notes` / `post_anomaly_anchor_date`.
Those are hand-authored blocks in cycle_params.json (see #47 PR-3). Re-author
them now against the fresh fit — the TS validator (src/lib/forecast/params.ts)
fails loudly if they're missing, and figures.py reads the anomaly window for
the history chart's shading.
================================================================================
"""

if __name__ == "__main__":
    build_params.main()
    print(REMINDER)
    figures.main()
