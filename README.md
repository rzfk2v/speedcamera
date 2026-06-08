# Speed Camera Alert

An offline-capable Progressive Web App that gives spoken and visual warnings when
you approach a speed camera. Runs entirely on a phone.

## How it works

- Camera locations come from OpenStreetMap (`highway=speed_camera`), fetched via the
  Overpass API into a compact `cameras.json` that is bundled and cached for fully
  offline use.
- The app watches your GPS and warns about cameras ahead on your side of the road
  (it uses each camera's `direction` tag to ignore the opposite carriageway), with a
  speed-scaled pre-warning and a closer alert as you get nearer.

## Use

Open the hosted URL in mobile Chrome → menu → **Install app** → grant Location.

## Develop

```bash
./data/update.sh                               # refresh data AND deploy (commit + push)
python3 data/fetch_cameras.py                  # refresh data only, no deploy
python3 -m http.server 8000 --directory app    # serve locally for testing
```

## ⚠️ Disclaimer

A driving aid, not a substitute for watching the road and your speedometer. Camera
data is community-sourced and may be incomplete or out of date. Speed-camera-warning
apps are restricted or illegal in some countries (e.g. France, Switzerland) — check
local law before use.
