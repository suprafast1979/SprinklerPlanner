# Sprinkler Planner

A mobile-friendly Progressive Web App for walking a property boundary and generating suggested portable-sprinkler locations.

## What works

- Live phone GPS with accuracy display
- Automatic perimeter recording while walking
- Manual corner points by GPS or map tap
- Polygon area in square feet
- Radius or diameter entry
- Hex-style suggested sprinkler spacing
- Draggable sprinkler markers and coverage circles
- Save locally on the phone
- Export/import JSON backups
- Installable home-screen web app

## Run locally

Geolocation normally requires HTTPS or localhost.

### Simple computer test

From this folder:

```bash
python -m http.server 8080
```

Open `http://localhost:8080`.

### Phone deployment

Upload the folder to any HTTPS static host such as GitHub Pages, Cloudflare Pages, Netlify, or Firebase Hosting.

## Important limitation

Phone GPS often varies by several feet or more. Use the satellite image and drag suggested markers into their exact visible positions after recording the perimeter.
