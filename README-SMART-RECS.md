# Sprinkler Planner v9 – Smart Purchase Recommendations

## What was added
When you run **Optimize layout** with “Use only the quantity I own” checked and the resulting coverage is under 98%, the app now shows a **Smart Recommendation** panel.

The panel includes:
- A clear explanation of the coverage gap
- How many extra units of your current type are roughly needed
- Notes about overspray if relevant
- **5 clickable Amazon product search links** tailored to the gap:
  1. More of the same sprinkler you already own
  2. Larger-radius or heavy-duty impact sprinklers
  3. Pattern alternative (oscillating vs impact)
  4. Popular brands (Orbit / Rain Bird / Nelson)
  5. Current “best portable sprinklers for large yards”

This is a rule-based “AI-style” recommendation engine that uses:
- Actual sampled coverage %
- Uncovered square footage
- Your inventory quantity & sprinkler specs
- Zone area and pattern type

No external AI API is required — everything runs client-side.

## How to deploy
1. Replace the files in your GitHub Pages repo with the ones from this zip (especially `app.js`, `index.html`, `styles.css`, `service-worker.js`).
2. Commit & push.
3. On your phone, hard-refresh the app (or clear site data once) so the new service worker (`v9`) loads.

## Notes
- The recommendation panel only appears when inventory is the limiting factor.
- Links open Amazon search results in a new tab. They are not affiliate links.
- You can still clear the layout or switch zones to hide the panel.
