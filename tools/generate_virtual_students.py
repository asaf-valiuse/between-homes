import json
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
SIGNATURES_PATH = ROOT / "signatures.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class Place:
    city: str
    street: str
    lat: float
    lon: float


# Hardcoded locations (no external geocoding). Coordinates are approximate city/area points.
PLACES: list[Place] = [
    Place("תל אביב", "דיזנגוף", 32.0853, 34.7818),
    Place("ירושלים", "יפו", 31.7780, 35.2240),
    Place("חיפה", "הרצל", 32.8191, 34.9984),
    Place("באר שבע", "רגר", 31.2529, 34.7915),
    Place("נתניה", "הרצל", 32.3215, 34.8532),
    Place("פתח תקווה", "ז'בוטינסקי", 32.0886, 34.8866),
    Place("רמת גן", "ביאליק", 32.0807, 34.8140),
    Place("חולון", "סוקולוב", 32.0158, 34.7874),
    Place("ראשון לציון", "רוטשילד", 31.9723, 34.8060),
    Place("רחובות", "הרצל", 31.8948, 34.8113),
    Place("אשדוד", "הבנים", 31.8044, 34.6553),
    Place("אשקלון", "בן גוריון", 31.6688, 34.5743),
    Place("עכו", "ההגנה", 32.9282, 35.0756),
    Place("נהריה", "געתון", 33.0059, 35.0946),
    Place("טבריה", "הגולן", 32.7922, 35.5312),
    Place("נצרת", "פאולוס השישי", 32.7019, 35.3035),
    Place("כרמיאל", "הנשיא", 32.9170, 35.2980),
    Place("מודיעין", "דם המכבים", 31.8930, 35.0090),
    Place("הרצליה", "סוקולוב", 32.1656, 34.8430),
    Place("כפר סבא", "ויצמן", 32.1750, 34.9070),
]

def make_address(p: Place) -> dict:
    number = str(random.randint(1, 120))
    belonging_rate = random.randint(1, 10)
    display = f"{p.city}, Israel"
    return {
        "id": str(uuid4()),
        "country": "ישראל",
        "state": "",
        "city": p.city,
        "street": p.street,
        "number": number,
        "belonging_rate": belonging_rate,
        "valid": True,
        "lat": p.lat,
        "lon": p.lon,
        "displayName": display,
    }


def make_record(student_name: str, stops: list[Place]) -> dict:
    addresses = [make_address(p) for p in stops]
    points = [
        {
            "lat": a["lat"],
            "lon": a["lon"],
            "label": a.get("displayName") or f"{a['city']}, Israel",
        }
        for a in addresses
    ]

    signature = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "studentName": student_name,
        "points": points,
        "skippedInvalid": 0,
        "addresses": addresses,
        "options": {"geoLayerEnabled": False},
    }

    return {
        "id": str(uuid4()),
        "createdAt": now_iso(),
        "studentName": student_name,
        "signature": signature,
        "client": {"userAgent": "VirtualStudent/1.0"},
    }


def main() -> int:
    if not SIGNATURES_PATH.exists():
        print(f"Missing {SIGNATURES_PATH}")
        return 2

    data = json.loads(SIGNATURES_PATH.read_text(encoding="utf-8") or "[]")
    if not isinstance(data, list):
        print("signatures.json is not a JSON array")
        return 2

    # Deterministic generation for repeatability.
    random.seed(42)

    existing_names = {
        str(item.get("studentName") or "").strip().lower()
        for item in data
        if isinstance(item, dict)
    }

    # Generate 12 virtual students.
    created = 0
    for i in range(1, 13):
        name = f"Student {i:02d}"
        if name.lower() in existing_names:
            continue

        k = random.randint(4, 9)
        stops = random.sample(PLACES, k=k)
        data.append(make_record(name, stops))
        created += 1

    SIGNATURES_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"Appended {created} virtual student signature(s). Total now: {len(data)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
