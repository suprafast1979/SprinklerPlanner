# Sprinkler Planner – GPS Accuracy Update

## What to do
1. Download and unzip this file.
2. In your GitHub repository, replace the existing `app.js` with the one from this zip.
3. Commit the change.
4. On your phone, hard-refresh the app (or clear site data once) so the new service worker loads.

## What changed
- Tighter GPS options (`maximumAge: 0`, fresh high-accuracy fixes)
- Better sample averaging (requires at least 2 good readings)
- Accuracy number now changes color:
  - Green ≤ 12 ft
  - Yellow ≤ 25 ft
  - Red > 25 ft
- In Set Up mode the “Placed” button stays disabled until you are close **and** accuracy is acceptable (≤ 14 ft)
- Slightly stricter jump rejection while recording a perimeter

All other files (`index.html`, `styles.css`, `service-worker.js`, etc.) stay the same.
