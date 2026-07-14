#!/usr/bin/env python3
"""Copy this LifePath project folder to a target backup folder.

Designed for cases where the desired backup destination is outside the VS Code
workspace root.

Example:
  python3 tools/backup_to_serverbk.py --out \
    "/Users/hilalustig/Documents/תקשורת חזותית/שנה ד׳/רב תרבותיות/code/serverbk"

Notes:
- Excludes: .venv, __pycache__, server.pid
- Copies everything else (including fonts/, tools/, backup-*/).
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


EXCLUDE_DIRS = {".venv", "__pycache__"}
EXCLUDE_FILES = {"server.pid"}


def should_exclude_dir(name: str) -> bool:
    return name in EXCLUDE_DIRS or name.startswith(".") and name not in {".vscode"}


def should_exclude_file(name: str) -> bool:
    return name in EXCLUDE_FILES or name == ".DS_Store"


def copy_project(src_root: Path, dst_root: Path) -> None:
    src_root = src_root.resolve()
    dst_root = dst_root.resolve()

    if dst_root == src_root:
        raise SystemExit("Destination is the same as source")

    dst_root.mkdir(parents=True, exist_ok=True)

    for dirpath, dirnames, filenames in os.walk(src_root):
        rel_dir = Path(dirpath).resolve().relative_to(src_root)

        # Mutate dirnames in-place to prune traversal.
        dirnames[:] = [d for d in dirnames if not should_exclude_dir(d)]

        out_dir = dst_root / rel_dir
        out_dir.mkdir(parents=True, exist_ok=True)

        for filename in filenames:
            if should_exclude_file(filename):
                continue

            src_file = Path(dirpath) / filename
            # Skip copying the destination folder if it lives inside the source for some reason.
            try:
                src_file.resolve().relative_to(dst_root)
                continue
            except Exception:
                pass

            dst_file = out_dir / filename
            shutil.copy2(src_file, dst_file)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--out",
        required=True,
        help="Output backup folder path (will be created if missing)",
    )
    args = ap.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    out_dir = Path(args.out).expanduser()

    copy_project(project_root, out_dir)
    print(f"Backed up LifePath project to: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
