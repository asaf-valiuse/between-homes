import argparse
import json
import random
from datetime import datetime
from pathlib import Path


def clamp_int(value: object, lo: int, hi: int, default: int) -> int:
    try:
        n = int(float(str(value).strip()))
    except Exception:
        return default
    return max(lo, min(hi, n))


def stable_1_10_from_id(addr_id: object) -> int:
    s = str(addr_id or "")
    # Simple stable hash.
    h = 0
    for ch in s:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return 1 + (h % 10)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Replace address.sentiment with address.belonging_rate (1-10) in signatures.json",
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
    parser.add_argument(
        "--random",
        action="store_true",
        help="Use true randomness for missing values (default: stable by address id)",
    )
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        raise SystemExit(f"File not found: {path}")

    data = json.loads(path.read_text(encoding="utf-8") or "[]")
    if not isinstance(data, list):
        raise SystemExit("Expected a JSON array at top-level")

    if args.random:
        random.seed()

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

            # Remove legacy sentiment if present.
            if "sentiment" in addr:
                addr.pop("sentiment", None)
                changed_addresses += 1
                record_changed = True

            if "belonging_rate" not in addr:
                if args.random:
                    addr["belonging_rate"] = random.randint(1, 10)
                else:
                    addr["belonging_rate"] = stable_1_10_from_id(addr.get("id"))
                changed_addresses += 1
                record_changed = True
            else:
                normalized = clamp_int(addr.get("belonging_rate"), 1, 10, 5)
                if addr.get("belonging_rate") != normalized:
                    addr["belonging_rate"] = normalized
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
