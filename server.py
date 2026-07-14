import json
import os
import re
import sys
import argparse
import sqlite3
import threading
import atexit
import time
import traceback
import signal
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
SIGNATURES_JSON_SEED_PATH = ROOT / "signatures.json"


def _default_database_path() -> Path:
    configured = os.environ.get("LIFEPATH_DB_PATH")
    if configured:
        return Path(configured).expanduser()

    home = os.environ.get("HOME")
    if os.environ.get("WEBSITE_SITE_NAME") and home:
        return Path(home) / "data" / "lifepath.sqlite3"

    return ROOT / "lifepath.sqlite3"


DATABASE_PATH = _default_database_path()
PID_PATH = ROOT / "server.pid"
MP3_NEW_PATH = ROOT / "mp3" / "new"
_lock = threading.Lock()


class ReuseThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


OVERPASS_ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]


HEBREW_GEOCODE_ALIASES = {
    "ארצות הברית": "United States",
    "ארהב": "United States",
    "ארה\"ב": "United States",
    "אמריקה": "United States",
    "בריטניה": "United Kingdom",
    "הממלכה המאוחדת": "United Kingdom",
    "אנגליה": "England",
    "צרפת": "France",
    "גרמניה": "Germany",
    "איטליה": "Italy",
    "ספרד": "Spain",
    "פורטוגל": "Portugal",
    "הולנד": "Netherlands",
    "יוון": "Greece",
    "אוקראינה": "Ukraine",
    "קנדה": "Canada",
    "אוסטרליה": "Australia",
    "יפן": "Japan",
    "ניו יורק": "New York",
    "לוס אנג'לס": "Los Angeles",
    "לוס אנגלס": "Los Angeles",
    "סן פרנסיסקו": "San Francisco",
    "שיקגו": "Chicago",
    "מיאמי": "Miami",
    "בוסטון": "Boston",
    "וושינגטון": "Washington",
    "לונדון": "London",
    "פריז": "Paris",
    "ברלין": "Berlin",
    "רומא": "Rome",
    "מילאנו": "Milan",
    "מדריד": "Madrid",
    "ברצלונה": "Barcelona",
    "אמסטרדם": "Amsterdam",
    "אתונה": "Athens",
    "ניקולאייב": "Mykolaiv",
    "ניקולייב": "Mykolaiv",
    "מיקולאייב": "Mykolaiv",
    "מיקולייב": "Mykolaiv",
    "טוקיו": "Tokyo",
    "טורונטו": "Toronto",
    "מונטריאול": "Montreal",
    "סידני": "Sydney",
    "מלבורן": "Melbourne",
    "ברודווי": "Broadway",
    "ברודוואי": "Broadway",
    "השדרה החמישית": "Fifth Avenue",
    "פיפת אווניו": "Fifth Avenue",
    "אוקספורד סטריט": "Oxford Street",
    "שאנז אליזה": "Champs-Élysées",
}


HEBREW_TRANSLITERATION = {
    "א": "a", "ב": "b", "ג": "g", "ד": "d", "ה": "h", "ו": "o", "ז": "z", "ח": "h", "ט": "t", "י": "i",
    "כ": "k", "ך": "k", "ל": "l", "מ": "m", "ם": "m", "נ": "n", "ן": "n", "ס": "s", "ע": "a", "פ": "p",
    "ף": "f", "צ": "tz", "ץ": "tz", "ק": "k", "ר": "r", "ש": "sh", "ת": "t",
}


def _contains_hebrew(value: str) -> bool:
    return bool(re.search(r"[\u0590-\u05FF]", str(value or "")))


def _replace_hebrew_geocode_aliases(value: str) -> str:
    out = str(value or "")
    for hebrew, latin in sorted(HEBREW_GEOCODE_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        out = out.replace(hebrew, latin)
    return out


def _transliterate_hebrew_for_geocode(value: str) -> str:
    text = _replace_hebrew_geocode_aliases(value)
    chars = []
    for ch in text:
        chars.append(HEBREW_TRANSLITERATION.get(ch, ch))
    return re.sub(r"\s+", " ", "".join(chars)).strip()


def _geocode_text_variants(value: str) -> list[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    variants = [raw]
    aliased = _replace_hebrew_geocode_aliases(raw).strip()
    if aliased and aliased not in variants:
        variants.append(aliased)
    if _contains_hebrew(aliased):
        transliterated = _transliterate_hebrew_for_geocode(aliased).strip()
        if transliterated and transliterated not in variants:
            variants.append(transliterated)
    return variants


def _photon_query_variants_from_params(params: dict) -> list[str]:
    if params.get("q"):
        return _geocode_text_variants(str(params.get("q") or ""))

    street_variants = _geocode_text_variants(str(params.get("street") or "")) or [""]
    city_variants = _geocode_text_variants(str(params.get("city") or "")) or [""]
    state_variants = _geocode_text_variants(str(params.get("state") or "")) or [""]
    country_variants = _geocode_text_variants(str(params.get("country") or "")) or [""]
    queries = []
    max_variants = max(len(street_variants), len(city_variants), len(state_variants), len(country_variants))
    for index in range(max_variants):
        parts = [
            street_variants[min(index, len(street_variants) - 1)],
            city_variants[min(index, len(city_variants) - 1)],
            state_variants[min(index, len(state_variants) - 1)],
            country_variants[min(index, len(country_variants) - 1)],
        ]
        query = ", ".join(str(part or "").strip() for part in parts if str(part or "").strip())
        if query and query not in queries:
            queries.append(query)
    return queries


def _fetch_json(url: str, *, headers: Optional[dict] = None, timeout: int = 20):
    req = Request(url, headers=headers or {}, method="GET")
    with urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return json.loads(body.decode("utf-8"))


def _photon_query_from_params(params: dict) -> str:
    if params.get("q"):
        return str(params.get("q") or "").strip()
    parts = [
        params.get("street"),
        params.get("city"),
        params.get("state"),
        params.get("country"),
    ]
    return ", ".join(str(part or "").strip() for part in parts if str(part or "").strip())


def _photon_feature_to_nominatim_item(feature: dict) -> Optional[dict]:
    geometry = feature.get("geometry") if isinstance(feature, dict) else None
    properties = feature.get("properties") if isinstance(feature, dict) else None
    coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
    if not isinstance(properties, dict) or not isinstance(coordinates, list) or len(coordinates) < 2:
        return None

    try:
        lon = float(coordinates[0])
        lat = float(coordinates[1])
    except Exception:
        return None

    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None

    address = {
        "house_number": properties.get("housenumber") or "",
        "road": properties.get("street") or properties.get("name") or "",
        "city": properties.get("city") or properties.get("county") or "",
        "state": properties.get("state") or "",
        "postcode": properties.get("postcode") or "",
        "country": properties.get("country") or "",
    }
    display_parts = [
        " ".join(str(part or "").strip() for part in (address["road"], address["house_number"]) if str(part or "").strip()),
        address["city"],
        address["state"],
        address["country"],
    ]
    display_name = ", ".join(str(part or "").strip() for part in display_parts if str(part or "").strip())
    return {
        "place_id": properties.get("osm_id") or properties.get("osm_key") or display_name,
        "lat": str(lat),
        "lon": str(lon),
        "display_name": display_name or str(properties.get("name") or ""),
        "class": properties.get("osm_key") or "place",
        "type": properties.get("osm_value") or properties.get("type") or "address",
        "importance": properties.get("extent") or 0,
        "address": address,
        "namedetails": {
            "name": properties.get("name") or "",
            "name:en": properties.get("name") or "",
        },
        "extratags": {},
        "source": "photon",
    }


def _search_photon(params: dict, accept_language: str) -> list:
    queries = _photon_query_variants_from_params(params)
    if not queries:
        return []
    limit = str(params.get("limit") or "20").strip()
    lang = (accept_language or "en").split(",", 1)[0].split("-", 1)[0].strip().lower() or "en"
    if lang not in ("de", "en", "fr", "it"):
        lang = "en"
    last_items = []
    for query in queries:
        photon_params = {
            "q": query,
            "limit": limit,
            "lang": lang,
        }
        url = "https://photon.komoot.io/api/?" + urlencode(photon_params)
        data = _fetch_json(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "LifePath local geocoder (educational project)",
            },
            timeout=20,
        )
        features = data.get("features") if isinstance(data, dict) else None
        if not isinstance(features, list):
            continue
        items = []
        for feature in features:
            item = _photon_feature_to_nominatim_item(feature)
            if item:
                item["fallback_query"] = query
                items.append(item)
        if items:
            return items
        last_items = items
    return last_items


def _normalize_belonging_rate(value, *, addr_id: Optional[str] = None) -> int:
    try:
        n = int(float(str(value).strip()))
        if 1 <= n <= 10:
            return n
    except Exception:
        pass

    # If missing/invalid, use a stable pseudo-random value per address id
    # (so it doesn't change across saves).
    if addr_id:
        h = 0
        for ch in addr_id:
            h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        return 1 + (h % 10)

    return 5


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json_file(path: Path):
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # If file is corrupted/empty, avoid crashing the kiosk.
        return []


def _default_state() -> dict:
    return {
        "savedMaps": [],
        "savedMapsSerial": 0,
        "allMapsHidden": [],
        "basemapStyleId": "",
        "updatedAt": None,
    }


def _store_from_json_raw(raw) -> dict:
    if isinstance(raw, list):
        return {
            "signatures": raw,
            "state": _default_state(),
        }

    if isinstance(raw, dict):
        sigs = raw.get("signatures")
        state = raw.get("state")
        return {
            "signatures": sigs if isinstance(sigs, list) else [],
            "state": state if isinstance(state, dict) else _default_state(),
        }

    return {
        "signatures": [],
        "state": _default_state(),
    }


def _connect_db() -> sqlite3.Connection:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    with _connect_db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS signatures (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                student_name TEXT NOT NULL DEFAULT '',
                record_json TEXT NOT NULL,
                map_json TEXT
            )
            """
        )
        # Schema migration for older deployments.
        cols = conn.execute("PRAGMA table_info(signatures)").fetchall()
        col_names = {str(row[1]) for row in cols}
        if "map_json" not in col_names:
            conn.execute("ALTER TABLE signatures ADD COLUMN map_json TEXT")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state_json TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS store_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )

        initialized = conn.execute("SELECT value FROM store_meta WHERE key = 'initialized'").fetchone()
        if initialized:
            return

        seed = _store_from_json_raw(_read_json_file(SIGNATURES_JSON_SEED_PATH))
        state = seed.get("state") if isinstance(seed.get("state"), dict) else _default_state()
        conn.execute(
            "INSERT OR REPLACE INTO app_state (id, state_json) VALUES (1, ?)",
            (json.dumps(state, ensure_ascii=False),),
        )

        for record in seed.get("signatures") if isinstance(seed.get("signatures"), list) else []:
            if not isinstance(record, dict):
                continue
            record_id = str(record.get("id") or f"sig-{int(datetime.now().timestamp() * 1000)}").strip()
            if not record_id:
                continue
            map_obj = record.get("map") if isinstance(record.get("map"), dict) else None
            conn.execute(
                """
                INSERT OR REPLACE INTO signatures (id, created_at, student_name, record_json, map_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    record_id,
                    str(record.get("createdAt") or _now_iso()),
                    str(record.get("studentName") or ""),
                    json.dumps(record, ensure_ascii=False),
                    json.dumps(map_obj, ensure_ascii=False) if map_obj else None,
                ),
            )

        conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('initialized', ?)", (_now_iso(),))


def _read_store() -> dict:
    _init_db()
    with _connect_db() as conn:
        rows = conn.execute("SELECT record_json FROM signatures ORDER BY rowid").fetchall()
        signatures = []
        for row in rows:
            try:
                record = json.loads(row["record_json"])
                if isinstance(record, dict):
                    signatures.append(record)
            except json.JSONDecodeError:
                continue

        state_row = conn.execute("SELECT state_json FROM app_state WHERE id = 1").fetchone()
        state = _default_state()
        if state_row:
            try:
                parsed_state = json.loads(state_row["state_json"])
                if isinstance(parsed_state, dict):
                    state = parsed_state
            except json.JSONDecodeError:
                pass

        return {
            "signatures": signatures,
            "state": state,
        }


def _normalize_name_for_label(name: str) -> str:
    return re.sub(r"\s+", "", str(name or "").strip())


def _build_map_snapshot_from_record(record: dict, serial: int) -> dict | None:
    if not isinstance(record, dict):
        return None
    signature = record.get("signature") if isinstance(record.get("signature"), dict) else {}
    addresses = signature.get("addresses") if isinstance(signature.get("addresses"), list) else []
    if not addresses:
        return None

    full_name = str(record.get("studentName") or signature.get("studentName") or "").strip()
    count = len(addresses)
    count_str = str(max(0, int(count))).zfill(2)
    label_name = _normalize_name_for_label(full_name)
    label = f"{label_name}.{count_str}addrs" if label_name else f"lifepath.{count_str}addrs"

    lats = []
    lons = []
    for a in addresses:
        if not isinstance(a, dict):
            continue
        lat = a.get("lat")
        lon = a.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            lats.append(float(lat))
            lons.append(float(lon))

    if lats and lons:
        view = {
            "lat": sum(lats) / len(lats),
            "lng": sum(lons) / len(lons),
            "zoom": 7,
        }
    else:
        view = {"lat": 31.5, "lng": 35.1, "zoom": 7}

    options = signature.get("options") if isinstance(signature.get("options"), dict) else {}
    snap = {
        "version": 1,
        "id": str(record.get("id") or f"map-{serial}"),
        "label": label,
        "serial": int(serial),
        "fullName": full_name,
        "count": count,
        "savedAt": str(record.get("createdAt") or record.get("created_at") or _now_iso()),
        "updatedAt": _now_iso(),
        "view": view,
        "geoLayerEnabled": bool(options.get("geoLayerEnabled")),
        "addresses": addresses,
    }
    return snap


def _list_maps_from_signatures(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT id, created_at, record_json, map_json FROM signatures ORDER BY created_at, rowid").fetchall()
    out: list[dict] = []
    serial = 0
    for row in rows:
        serial += 1
        map_obj = None
        try:
            raw_map = row["map_json"]
            if raw_map:
                parsed_map = json.loads(raw_map)
                if isinstance(parsed_map, dict):
                    map_obj = parsed_map
        except Exception:
            map_obj = None

        if map_obj is None:
            try:
                rec = json.loads(row["record_json"])
            except Exception:
                rec = {}
            if isinstance(rec, dict):
                if not rec.get("id"):
                    rec["id"] = str(row["id"] or "")
                if not rec.get("createdAt"):
                    rec["createdAt"] = str(row["created_at"] or _now_iso())
            map_obj = _build_map_snapshot_from_record(rec, serial)

        if isinstance(map_obj, dict):
            # Ensure consistent serial ordering for UI labels.
            map_obj["serial"] = serial
            out.append(map_obj)
    return out


def _rebuild_maps_in_db(*, overwrite: bool = False) -> dict:
    _init_db()
    built = 0
    skipped = 0
    with _connect_db() as conn:
        rows = conn.execute("SELECT id, created_at, record_json, map_json FROM signatures ORDER BY created_at, rowid").fetchall()
        serial = 0
        for row in rows:
            serial += 1
            if row["map_json"] and not overwrite:
                skipped += 1
                continue
            try:
                rec = json.loads(row["record_json"])
            except Exception:
                rec = {}
            if isinstance(rec, dict):
                if not rec.get("id"):
                    rec["id"] = str(row["id"] or "")
                if not rec.get("createdAt"):
                    rec["createdAt"] = str(row["created_at"] or _now_iso())
            snap = _build_map_snapshot_from_record(rec, serial)
            if not snap:
                skipped += 1
                continue
            conn.execute("UPDATE signatures SET map_json = ? WHERE id = ?", (json.dumps(snap, ensure_ascii=False), str(row["id"] or "")))
            built += 1
    return {"ok": True, "built": built, "skipped": skipped}


def _write_store(store: dict) -> None:
    _init_db()
    signatures = store.get("signatures")
    state = store.get("state")
    with _connect_db() as conn:
        conn.execute("DELETE FROM signatures")
        for record in signatures if isinstance(signatures, list) else []:
            if not isinstance(record, dict):
                continue
            record_id = str(record.get("id") or f"sig-{int(datetime.now().timestamp() * 1000)}").strip()
            if not record_id:
                continue
            map_obj = record.get("map") if isinstance(record.get("map"), dict) else None
            conn.execute(
                """
                INSERT OR REPLACE INTO signatures (id, created_at, student_name, record_json, map_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    record_id,
                    str(record.get("createdAt") or _now_iso()),
                    str(record.get("studentName") or ""),
                    json.dumps(record, ensure_ascii=False),
                    json.dumps(map_obj, ensure_ascii=False) if map_obj else None,
                ),
            )

        conn.execute(
            "INSERT OR REPLACE INTO app_state (id, state_json) VALUES (1, ?)",
            (json.dumps(state if isinstance(state, dict) else _default_state(), ensure_ascii=False),),
        )


def _atomic_write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_path, path)


def _build_mp3_manifest() -> dict:
    """Build a manifest of mp3/new files.

    Filenames are parsed to infer semantic meaning:
    - Loop files: "in 1-4.mp3", "out 7-10 (2).mp3" => kind + numeric range + variants
    - Tick files: "tick 1.mp3" => tick layer keyed by 1..N

    The client uses this to automatically match updated belonging ranges.
    """

    def _sorted_ranges(ranges: dict) -> list[dict]:
        out: list[dict] = []
        for (lo, hi), files in ranges.items():
            out.append({"lo": lo, "hi": hi, "files": sorted(files)})
        out.sort(key=lambda x: (x["lo"], x["hi"]))
        return out

    loops_in: dict[tuple[int, int], set[str]] = {}
    loops_out: dict[tuple[int, int], set[str]] = {}
    ticks: dict[int, set[str]] = {}
    ignored: list[str] = []

    try:
        if not MP3_NEW_PATH.exists() or not MP3_NEW_PATH.is_dir():
            return {
                "ok": True,
                "generatedAt": _now_iso(),
                "baseDir": "mp3/new/",
                "loops": {"in": [], "out": []},
                "ticks": {},
                "ignored": [],
            }

        for p in sorted(MP3_NEW_PATH.iterdir(), key=lambda x: x.name.lower()):
            try:
                if not p.is_file():
                    continue
                name = p.name
                if name.startswith("."):
                    continue
                if not re.search(r"\.(mp3|m4a|wav|ogg)$", name, flags=re.IGNORECASE):
                    continue

                m_loop = re.match(
                    r"^(in|out)\s+(\d+)\s*-\s*(\d+)\s*[\.\-_]*\s*(?:\((\d+)\))?\s*\.(mp3|m4a|wav|ogg)$",
                    name,
                    flags=re.IGNORECASE,
                )
                if m_loop:
                    kind = (m_loop.group(1) or "").lower()
                    lo = int(m_loop.group(2))
                    hi = int(m_loop.group(3))
                    if lo > hi:
                        lo, hi = hi, lo
                    key = (lo, hi)
                    if kind == "in":
                        loops_in.setdefault(key, set()).add(name)
                    else:
                        loops_out.setdefault(key, set()).add(name)
                    continue

                m_tick = re.match(
                    r"^tick\s+(\d+)\s*(?:\((\d+)\))?\s*\.(mp3|m4a|wav|ogg)$",
                    name,
                    flags=re.IGNORECASE,
                )
                if m_tick:
                    idx = int(m_tick.group(1))
                    ticks.setdefault(idx, set()).add(name)
                    continue

                ignored.append(name)
            except Exception:
                continue
    except Exception:
        return {
            "ok": False,
            "generatedAt": _now_iso(),
            "baseDir": "mp3/new/",
            "error": "manifest_failed",
        }

    ticks_out: dict[str, list[str]] = {}
    for k, v in ticks.items():
        ticks_out[str(k)] = sorted(v)

    return {
        "ok": True,
        "generatedAt": _now_iso(),
        "baseDir": "mp3/new/",
        "loops": {
            "in": _sorted_ranges(loops_in),
            "out": _sorted_ranges(loops_out),
        },
        "ticks": ticks_out,
        "ignored": ignored,
    }


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Avoid stale CSS/JS in kiosk-like usage.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/signatures", "/api/overpass", "/api/nominatim", "/api/state", "/api/maps/rebuild"):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
            return

        if parsed.path == "/api/overpass":
            query = payload.get("query")
            if not isinstance(query, str) or not query.strip():
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing_query"})
                return

            data = query.strip().encode("utf-8")
            last_error = None
            for endpoint in OVERPASS_ENDPOINTS:
                try:
                    req = Request(
                        endpoint,
                        data=data,
                        headers={
                            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                            "Accept": "application/json",
                            "User-Agent": self.headers.get("User-Agent", "lifepath")[:200],
                        },
                        method="POST",
                    )
                    with urlopen(req, timeout=25) as resp:
                        body = resp.read()
                        ctype = (resp.headers.get("Content-Type") or "").lower()
                        if "application/json" not in ctype and "json" not in ctype:
                            last_error = f"non_json_response:{ctype or 'unknown'}"
                            continue
                        try:
                            parsed_json = json.loads(body.decode("utf-8"))
                        except json.JSONDecodeError:
                            last_error = "invalid_json"
                            continue
                        self._send_json(HTTPStatus.OK, {"ok": True, "data": parsed_json})
                        return
                except Exception as e:
                    last_error = str(e)
                    continue

            self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "overpass_failed", "detail": last_error})
            return

        if parsed.path == "/api/nominatim":
            params = payload.get("params") if isinstance(payload, dict) else None
            if not isinstance(params, dict):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing_params"})
                return

            clean_params = {}
            for key, value in params.items():
                key_s = str(key or "").strip()
                value_s = str(value or "").strip()
                if key_s and value_s:
                    clean_params[key_s] = value_s

            if not clean_params.get("q") and not any(k in clean_params for k in ("street", "city", "country")):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing_query"})
                return

            clean_params.setdefault("format", "json")
            clean_params.setdefault("limit", "20")
            clean_params.setdefault("addressdetails", "1")
            clean_params.setdefault("namedetails", "1")
            clean_params.setdefault("extratags", "1")
            url = "https://nominatim.openstreetmap.org/search?" + urlencode(clean_params)
            nominatim_error = None
            try:
                parsed_json = _fetch_json(
                    url,
                    headers={
                        "Accept": "application/json",
                        "Accept-Language": self.headers.get("Accept-Language", "en")[:100],
                        "User-Agent": "LifePath local geocoder (educational project)",
                    },
                    timeout=20,
                )
                self._send_json(HTTPStatus.OK, {"ok": True, "data": parsed_json})
                return
            except Exception as e:
                nominatim_error = str(e)

            try:
                photon_items = _search_photon(clean_params, self.headers.get("Accept-Language", "en")[:100])
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "data": photon_items,
                        "source": "photon",
                        "fallbackFrom": "nominatim",
                        "fallbackDetail": nominatim_error,
                    },
                )
            except Exception as e:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {
                        "ok": False,
                        "error": "geocode_failed",
                        "detail": str(e),
                        "nominatimDetail": nominatim_error,
                    },
                )
            return

        if parsed.path == "/api/state":
            state_in = payload.get("state") if isinstance(payload, dict) else None
            # Allow posting either {state:{...}} or the state object directly.
            state_obj = state_in if isinstance(state_in, dict) else (payload if isinstance(payload, dict) else None)
            if not isinstance(state_obj, dict):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing_state"})
                return

            with _lock:
                store = _read_store()
                state = store.get("state") if isinstance(store.get("state"), dict) else _default_state()

                if "savedMaps" in state_obj:
                    saved_maps = state_obj.get("savedMaps")
                    state["savedMaps"] = saved_maps if isinstance(saved_maps, list) else []

                if "savedMapsSerial" in state_obj:
                    try:
                        n = int(float(str(state_obj.get("savedMapsSerial")).strip()))
                        state["savedMapsSerial"] = max(0, n)
                    except Exception:
                        state["savedMapsSerial"] = state.get("savedMapsSerial", 0) if isinstance(state.get("savedMapsSerial"), int) else 0

                if "allMapsHidden" in state_obj:
                    hidden = state_obj.get("allMapsHidden")
                    state["allMapsHidden"] = hidden if isinstance(hidden, list) else []

                if "basemapStyleId" in state_obj:
                    state["basemapStyleId"] = str(state_obj.get("basemapStyleId") or "").strip()

                state["updatedAt"] = _now_iso()
                store["state"] = state
                _write_store(store)

            self._send_json(HTTPStatus.OK, {"ok": True, "state": state})
            return

        if parsed.path == "/api/maps/rebuild":
            overwrite = bool(payload.get("overwrite")) if isinstance(payload, dict) else False
            result = _rebuild_maps_in_db(overwrite=overwrite)
            self._send_json(HTTPStatus.OK, result)
            return

        signature = payload.get("signature")
        if not isinstance(signature, dict):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing_signature"})
            return

        # Backfill / normalize belonging_rate on each address for consistent storage.
        addresses = signature.get("addresses")
        if isinstance(addresses, list):
            for addr in addresses:
                if isinstance(addr, dict):
                    addr_id = str(addr.get("id") or "").strip() or None
                    addr.pop("sentiment", None)
                    addr["belonging_rate"] = _normalize_belonging_rate(
                        addr.get("belonging_rate"),
                        addr_id=addr_id,
                    )

        student_name = str(payload.get("studentName") or "").strip()
        # Store the name both at the record level and inside signature details
        # for easy downstream consumption.
        if student_name and not str(signature.get("studentName") or "").strip():
            signature["studentName"] = student_name

        record = {
            "id": payload.get("id") or f"sig-{int(datetime.now().timestamp() * 1000)}",
            "createdAt": _now_iso(),
            "studentName": student_name,
            "signature": signature,
            "client": {
                "userAgent": self.headers.get("User-Agent", ""),
            },
        }
        map_payload = payload.get("map") if isinstance(payload, dict) else None

        with _lock:
            store = _read_store()
            sigs = store.get("signatures")
            if not isinstance(sigs, list):
                sigs = []
            sigs.append(record)
            store["signatures"] = sigs
            _write_store(store)

            # Persist map snapshot directly into the matching signature row.
            if isinstance(map_payload, dict):
                with _connect_db() as conn:
                    conn.execute(
                        "UPDATE signatures SET map_json = ? WHERE id = ?",
                        (json.dumps(map_payload, ensure_ascii=False), str(record.get("id") or "")),
                    )

            data = sigs

        self._send_json(HTTPStatus.OK, {"ok": True, "count": len(data)})

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/health":
            with _lock:
                store = _read_store()
                sigs = store.get("signatures")
                count = len(sigs) if isinstance(sigs, list) else 0
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "count": count,
                    "databaseFile": str(DATABASE_PATH),
                },
            )
            return

        if parsed.path == "/api/signatures":
            with _lock:
                store = _read_store()
                sigs = store.get("signatures")
            self._send_json(HTTPStatus.OK, {"ok": True, "signatures": sigs if isinstance(sigs, list) else []})
            return

        if parsed.path == "/api/maps":
            with _lock:
                _init_db()
                with _connect_db() as conn:
                    maps = _list_maps_from_signatures(conn)
            self._send_json(HTTPStatus.OK, {"ok": True, "maps": maps})
            return

        if parsed.path == "/api/state":
            with _lock:
                store = _read_store()
                state = store.get("state")
            self._send_json(HTTPStatus.OK, {"ok": True, "state": state if isinstance(state, dict) else _default_state()})
            return

        if parsed.path == "/api/mp3_manifest":
            self._send_json(HTTPStatus.OK, _build_mp3_manifest())
            return

        return super().do_GET()


_active_server: Optional[ReuseThreadingHTTPServer] = None


def _install_signal_handlers() -> None:
    def _handle(sig, _frame):
        srv = None
        try:
            global _active_server
            srv = _active_server
        except Exception:
            srv = None
        if srv is not None:
            try:
                srv.shutdown()
            except Exception:
                pass

    try:
        signal.signal(signal.SIGTERM, _handle)
    except Exception:
        pass
    try:
        signal.signal(signal.SIGINT, _handle)
    except Exception:
        pass


def run(host: str = "127.0.0.1", port: int = 5173) -> None:
    os.chdir(ROOT)
    _install_signal_handlers()
    server = ReuseThreadingHTTPServer((host, port), Handler)
    global _active_server
    _active_server = server
    print(f"Serving on http://{host}:{port}", flush=True)
    print(f"Writing database to: {DATABASE_PATH}", flush=True)
    try:
        server.serve_forever()
    finally:
        try:
            server.server_close()
        except Exception:
            pass
        _active_server = None


def run_supervised(host: str = "127.0.0.1", port: int = 5173, *, restart_delay_s: float = 1.0) -> None:
    delay = max(0.2, float(restart_delay_s or 1.0))
    while True:
        try:
            run(host=host, port=port)
            return
        except KeyboardInterrupt:
            return
        except Exception:
            print("[server] crashed; restarting...", file=sys.stderr, flush=True)
            traceback.print_exc()
            time.sleep(delay)


def _write_pid_file(path: Path) -> None:
    try:
        path.write_text(f"{os.getpid()}\n", encoding="utf-8")
    except Exception:
        # Don't crash if filesystem is read-only.
        pass


def _remove_pid_file(path: Path) -> None:
    try:
        if path.exists() and path.read_text(encoding="utf-8").strip() == str(os.getpid()):
            path.unlink()
    except Exception:
        pass


def health_check(host: str = "127.0.0.1", port: int = 5173) -> bool:
    url = f"http://{host}:{port}/api/health"
    try:
        req = Request(url, headers={"Accept": "application/json", "User-Agent": "lifepath-health"})
        with urlopen(req, timeout=3) as resp:
            if resp.status != 200:
                return False
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            return bool(data.get("ok"))
    except Exception:
        return False


def daemonize(*, log_path: Path) -> None:
    """Detach into a background daemon process (POSIX only).

    This avoids the VS Code task runner killing the server process tree when
    a task completes.
    """

    if not hasattr(os, "fork"):
        raise RuntimeError("daemonize is only supported on POSIX systems")

    sys.stdout.flush()
    sys.stderr.flush()

    pid = os.fork()
    if pid > 0:
        os._exit(0)

    os.setsid()

    pid = os.fork()
    if pid > 0:
        os._exit(0)

    # Redirect stdin to /dev/null.
    try:
        with open(os.devnull, "rb") as f_in:
            os.dup2(f_in.fileno(), 0)
    except Exception:
        pass

    # Redirect stdout/stderr to the provided log file.
    log_path = Path(log_path)
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "ab", buffering=0) as f_log:
            os.dup2(f_log.fileno(), 1)
            os.dup2(f_log.fileno(), 2)
    except Exception:
        # If we can't open the log file, keep running anyway.
        pass


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (use 0.0.0.0 to allow LAN access)")
    parser.add_argument("--port", type=int, default=5173, help="Bind port")
    parser.add_argument("--health-check", action="store_true", help="Exit 0 if server is reachable")
    parser.add_argument("--rebuild-maps", action="store_true", help="Backfill map snapshots into DB from signature records")
    parser.add_argument("--rebuild-maps-overwrite", action="store_true", help="When rebuilding, overwrite existing map snapshots")
    parser.add_argument("--daemon", action="store_true", help="Run as a background daemon (macOS/Linux)")
    parser.add_argument("--log-file", default=str(ROOT / "server.log"), help="Log file path for --daemon")
    parser.add_argument("--supervise", action="store_true", help="Restart the server if it crashes")
    parser.add_argument("--restart-delay", type=float, default=1.0, help="Delay (seconds) before restarting when supervised")
    parser.add_argument("--no-pid", action="store_true", help="Do not write server.pid")
    args = parser.parse_args(argv)

    if args.health_check:
        return 0 if health_check(args.host, args.port) else 1

    if args.rebuild_maps:
        result = _rebuild_maps_in_db(overwrite=bool(args.rebuild_maps_overwrite))
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0

    if args.daemon:
        daemonize(log_path=Path(args.log_file))

    if not args.no_pid:
        _write_pid_file(PID_PATH)
        atexit.register(_remove_pid_file, PID_PATH)

    if args.supervise:
        run_supervised(host=args.host, port=args.port, restart_delay_s=args.restart_delay)
    else:
        run(host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
