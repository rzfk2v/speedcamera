#!/usr/bin/env bash
# One-command camera-data updater.
# Refreshes speed-camera data from OpenStreetMap and — ONLY if the actual cameras
# changed (ignoring the date stamp) — commits + pushes app/cameras.json, which
# auto-deploys via GitHub Pages.
#
# Usage:
#   ./data/update.sh          # all Nordics (SE NO DK FI IS)
#   ./data/update.sh SE       # just Sweden (args pass through to fetch_cameras.py)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REL="app/cameras.json"

echo "→ Fetching latest cameras from OpenStreetMap…"
python3 "$REPO/data/fetch_cameras.py" "$@"

# Compare ONLY the camera data (not the 'generated' date) against what's committed,
# so a same-day re-run with no new cameras doesn't create a no-op commit.
verdict="$(python3 - "$REPO" "$REL" <<'PY'
import json, subprocess, sys, hashlib
repo, rel = sys.argv[1], sys.argv[2]
def sig(text):
    return hashlib.md5(json.dumps(json.loads(text)["cameras"], sort_keys=True).encode()).hexdigest()
new = sig(open(f"{repo}/{rel}").read())
try:
    old = sig(subprocess.check_output(["git", "-C", repo, "show", f"HEAD:{rel}"], text=True))
except Exception:
    old = None
print("CHANGED" if old != new else "SAME")
PY
)"

if [ "$verdict" = "SAME" ]; then
  git -C "$REPO" checkout -- "$REL" 2>/dev/null || true   # discard date-only churn
  echo "✓ Up to date — cameras unchanged. Nothing to deploy."
  exit 0
fi

count="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['count'])" "$REPO/$REL")"
echo "→ Cameras changed (now $count). Committing + pushing…"
git -C "$REPO" commit -q -m "Refresh camera data ($count cameras, $(date +%Y-%m-%d))" -- "$REL"
if git -C "$REPO" push -q; then
  echo "✓ Pushed — GitHub Pages will redeploy in ~1 min."
else
  echo "⚠ Commit made but push failed (offline?). Run 'git push' when back online." >&2
  exit 1
fi
