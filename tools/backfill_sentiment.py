import argparse
import json
from datetime import datetime
from pathlib import Path


ALLOWED = {"neutral", "joy", "calm", "love", "sad", "angry"}


def normalize_sentiment(value: object) -> str:
    key = str(value or "").strip().lower()
    return key if key in ALLOWED else "neutral"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill missing address.sentiment fields in signatures.json",
    )
    parser.add_argument(
        "--file",
        default="signatures.json",
        help="Path to signatures.json (default: signatures.json)",
    )
    parser.add_argument(
        "--inplace",
        action="store_true",
        help="Write changes back to the file (default: dry-run)",
    )
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        raise SystemExit(f"File not found: {path}")

    data = json.loads(path.read_text(encoding="utf-8") or "[]")
    if not isinstance(data, list):
        raise SystemExit("Expected a JSON array at top-level")

    changed_addresses = 0
    changed_records = 0

    for record in data:
        if not isinstance(record, dict):
            continue
        signature = record.get("signature")
        if not isinstance(signature, dict):
            continue
        addresses = signature.get("addresses")
        if not isinstance(addresses, list):
            continue

        record_changed = False
        for addr in addresses:
            if not isinstance(addr, dict):
                continue

            if "sentiment" not in addr:
                addr["sentiment"] = "neutral"
                changed_addresses += 1
                record_changed = True
            else:
                normalized = normalize_sentiment(addr.get("sentiment"))
                if addr.get("sentiment") != normalized:
                    addr["sentiment"] = normalized
                    changed_addresses += 1
                    record_changed = True

        if record_changed:
            changed_records += 1

    print(f"Records updated: {changed_records}")
    print(f"Addresses updated: {changed_addresses}")

    if args.inplace and changed_addresses:
        backup = path.with_suffix(path.suffix + ".bak-" + datetime.now().strftime("%Y%m%d%H%M%S"))
        backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote: {path}")
        print(f"Backup: {backup}")
    elif args.inplace:
        print("No changes needed.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
