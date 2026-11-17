#!/usr/bin/env python3
"""Regenerate each board's fonts-manifest.json and filesystem.json.

A static site can't list a directory, so the explorer (fonts.html) and the simulator
worker read manifests. Run this whenever you add or remove files in a bundle:

    ./generate_manifest.py            # every board under simulator/boards
    ./generate_manifest.py badger     # one board

For each simulator/boards/<board>/:

    fonts-manifest.json  vector (.af) <- filesystem/fonts, pixel (.ppf) <- filesystem/rom/fonts
    filesystem.json      every file under filesystem/ with its size
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BOARDS = ROOT / "simulator" / "boards"


def collect(directory: Path, ext: str) -> list[str]:
    if not directory.is_dir():
        print(f"warning: {directory} not found, skipping", file=sys.stderr)
        return []
    return sorted(p.name for p in directory.iterdir() if p.suffix.lower() == ext)


def write_manifests(board_dir: Path) -> None:
    filesystem = board_dir / "filesystem"
    sources = {
        "vector": (filesystem / "fonts", ".af"),
        "pixel": (filesystem / "rom" / "fonts", ".ppf"),
    }
    manifest = {kind: collect(directory, ext) for kind, (directory, ext) in sources.items()}
    fonts_out = board_dir / "fonts-manifest.json"
    fonts_out.write_text(json.dumps(manifest, indent=2) + "\n")
    counts = ", ".join(f"{len(v)} {k}" for k, v in manifest.items())
    print(f"Wrote {fonts_out.relative_to(ROOT)} ({counts})")

    files = {
        "/" + path.relative_to(filesystem).as_posix(): path.stat().st_size
        for path in sorted(filesystem.rglob("*"))
        if path.is_file() and "__pycache__" not in path.parts and path.name != ".DS_Store"
    }
    filesystem_out = board_dir / "filesystem.json"
    filesystem_out.write_text(json.dumps({"files": dict(sorted(files.items()))}, indent=4) + "\n")
    print(f"Wrote {filesystem_out.relative_to(ROOT)} ({len(files)} files)")


def main() -> int:
    names = sys.argv[1:] or sorted(path.name for path in BOARDS.iterdir() if (path / "filesystem").is_dir())
    for name in names:
        write_manifests(BOARDS / name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
