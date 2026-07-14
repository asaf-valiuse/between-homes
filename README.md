# LifePath (MVP)

A tiny static web app to collect a timeline of home addresses and draw a connected vector path (no basemap).

## Run locally

From this folder:

- Kiosk mode (recommended for student presentations):
  - `python server.py`
  - open http://localhost:5173
  - each click on “Save & Clear” appends to `signatures.json`

### Useful server options

- Bind to a different host/port:
  - `python server.py --host 127.0.0.1 --port 5173`
  - (Use `--host 0.0.0.0` if you need to access from another device on the same network.)

- Health check (returns exit code 0/1):
  - `python server.py --health-check`

## Notes

- Geocoding uses OpenStreetMap Nominatim (`https://nominatim.openstreetmap.org/search`). It is rate-limited.
- Geocode results are cached in `localStorage`.
- The drawing uses Leaflet with a clean canvas by default; a geographic layer can be toggled on.
