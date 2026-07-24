# LifePath (MVP)

A tiny static web app to collect a timeline of home addresses and draw a connected vector path (no basemap).

## Run locally

From this folder:

- Optional: add Google geocoding support by setting `GOOGLE_MAPS_API_KEY` in `.env`.
  - Example: `GOOGLE_MAPS_API_KEY=your-google-key`
  - Leave it blank to use the built-in Nominatim/Photon fallback only.

- Kiosk mode (recommended for student presentations):
  - `python server.py`
  - open http://localhost:5173
  - each click on “Save & Clear” appends to `lifepath.sqlite3`

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

## Data file

The live app database is SQLite.

The server uses this path order:

1. `LIFEPATH_DB_PATH`, if set.
2. `$HOME/data/lifepath.sqlite3` when running on Azure App Service.
3. `./lifepath.sqlite3` during local development.

On first startup, if the SQLite database does not exist, the server seeds it from the published `signatures.json` snapshot. On Azure App Service, live writes should stay in `$HOME/data`, which is persistent App Service storage, instead of the deployment package folder.
