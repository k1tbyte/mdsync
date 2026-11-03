"""Cuts the stretches of each recorded take that scenes.js uses into JPEGs.

    python3 tools/demo/promo/extract.py [take ...]

Reads artifacts/demos/<take>.mp4 (DEMO_VIDEO=1 takes), writes artifacts/promo/frames/<take>/NNNN.jpg
where NNNN = round(source seconds * 30), the numbering scenes.js and index.html use.
"""

import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DEMOS = f"{ROOT}/artifacts/demos"
OUT = f"{ROOT}/artifacts/promo/frames"

# Source seconds worth keeping per take; widen a range here when scenes.js reaches past it.
RANGES = {
    "wizard": [(3.0, 11.0), (24.5, 44.2)],
    "changes": [(0.0, 5.6), (22.5, 29.0)],
    "merge": [(0.2, 17.5)],
    "timeline": [(0.8, 13.0), (18.0, 27.8)],
    "live": [(1.5, 9.2), (10.2, 14.0), (15.8, 19.2)],
    "share": [(1.0, 2.8), (5.8, 10.0), (22.8, 26.0), (31.0, 35.0)],
    "links": [(0.5, 16.0), (19.0, 28.5), (35.5, 47.5)],
    "status": [(0.5, 10.6)],
}

for name in sys.argv[1:] or list(RANGES):
    out = f"{OUT}/{name}"
    subprocess.run(["rm", "-rf", out], check=True)
    os.makedirs(out)
    for start, end in RANGES[name]:
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y",
                "-ss", str(start), "-t", str(end - start),
                "-i", f"{DEMOS}/{name}.mp4",
                "-vf", "fps=30", "-q:v", "3",
                "-start_number", str(round(start * 30)),
                f"{out}/%04d.jpg",
            ],
            check=True,
        )
    print(name, len(os.listdir(out)))
