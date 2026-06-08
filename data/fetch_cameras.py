#!/usr/bin/env python3
"""Fetch Nordic speed cameras from OpenStreetMap via the Overpass API.

Source of truth: OSM nodes tagged ``highway=speed_camera``. Also pulls
``type=enforcement`` relations so average-speed ("section control") stretches
can be flagged. Output is a compact ``cameras.json`` consumed by the warning app.

Run:  python3 fetch_cameras.py            # all Nordic countries
      python3 fetch_cameras.py SE         # just Sweden
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Public Overpass instances; tried in order if one is busy.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Nordic countries by ISO 3166-1 alpha-2.
DEFAULT_COUNTRIES = ["SE", "NO", "DK", "FI", "IS"]

_HERE = os.path.dirname(os.path.abspath(__file__))
# Canonical copy lives next to this script; a second copy is written into the app
# so a data refresh updates the PWA without a manual copy step.
OUT_PATHS = [
    os.path.join(_HERE, "cameras.json"),
    os.path.join(_HERE, "..", "app", "cameras.json"),
]


def build_query(codes):
    areas = "\n".join(f'  area["ISO3166-1"="{c}"][admin_level=2];' for c in codes)
    # Camera nodes plus a count of enforcement relations (avg-speed stretches).
    # No geometry recursion — the MVP only needs the camera node coordinates.
    return f"""[out:json][timeout:300];
(
{areas}
)->.a;
(
  node["highway"="speed_camera"](area.a);
  relation["type"="enforcement"](area.a);
);
out body;
"""


def fetch(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    endpoint, data=body,
                    headers={"User-Agent": "nordic-speedcam/0.1 (personal project)"},
                )
                with urllib.request.urlopen(req, timeout=320) as r:
                    return json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code in (429, 504):  # busy / rate-limited -> back off
                    print(f"  {endpoint}: {e.code}, retrying...", file=sys.stderr)
                    time.sleep(5 * (attempt + 1))
                    continue
                break
            except (urllib.error.URLError, TimeoutError) as e:
                last_err = e
                time.sleep(3)
        print(f"  endpoint failed: {endpoint} ({last_err})", file=sys.stderr)
    raise SystemExit(f"All Overpass endpoints failed: {last_err}")


def main():
    codes = [c.upper() for c in sys.argv[1:]] or DEFAULT_COUNTRIES
    print(f"Querying Overpass for: {', '.join(codes)}", file=sys.stderr)
    res = fetch(build_query(codes))
    elements = res.get("elements", [])

    cameras = []
    enforcement_rels = 0
    for el in elements:
        t = el.get("type")
        tags = el.get("tags", {}) or {}
        if t == "node" and tags.get("highway") == "speed_camera":
            cam = {"id": el["id"], "lat": round(el["lat"], 6), "lon": round(el["lon"], 6)}
            if "direction" in tags:
                cam["dir"] = tags["direction"]
            if "maxspeed" in tags:
                cam["maxspeed"] = tags["maxspeed"]
            cameras.append(cam)
        elif t == "relation" and tags.get("type") == "enforcement":
            enforcement_rels += 1

    # Deterministic order: identical camera sets produce identical JSON regardless of
    # Overpass response ordering, so update.sh only commits when cameras really change.
    cameras.sort(key=lambda c: c["id"])

    out = {
        "source": "OpenStreetMap highway=speed_camera",
        "generated": time.strftime("%Y-%m-%d"),
        "countries": codes,
        "count": len(cameras),
        "cameras": cameras,
    }
    payload = json.dumps(out, separators=(",", ":"))
    for p in OUT_PATHS:
        if os.path.isdir(os.path.dirname(p)):
            with open(p, "w") as f:
                f.write(payload)

    size_kb = len(payload.encode()) / 1024
    print(f"\n  cameras (highway=speed_camera): {len(cameras)}", file=sys.stderr)
    print(f"  enforcement relations seen:     {enforcement_rels}", file=sys.stderr)
    print(f"  with direction tag:             {sum('dir' in c for c in cameras)}", file=sys.stderr)
    print(f"  with maxspeed tag:              {sum('maxspeed' in c for c in cameras)}", file=sys.stderr)
    print(f"  wrote {size_kb:.0f} KB to: {', '.join(OUT_PATHS)}", file=sys.stderr)
    print("\n  sample:", file=sys.stderr)
    for c in cameras[:5]:
        print(f"    {c}", file=sys.stderr)


if __name__ == "__main__":
    main()
