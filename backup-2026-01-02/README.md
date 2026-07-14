# LifePath (MVP)

A tiny static web app to collect a timeline of home addresses and draw a connected vector path (no basemap).

## Run locally

From this folder:

- Option A (Python):
  - `python -m http.server 5173`
  - open http://localhost:5173

## Notes

- Geocoding uses OpenStreetMap Nominatim (`https://nominatim.openstreetmap.org/search`). It is rate-limited.
- Geocode results are cached in `localStorage`.
- The drawing uses Leaflet but **no tile layer** is added, so only vector lines/points are shown.
