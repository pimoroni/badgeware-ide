#!/usr/bin/env python3
"""Copy Badgeware firmware releases into firmware/ so the IDE can fetch them same-origin.

GitHub release downloads don't send CORS headers, so the browser can't fetch them
directly. Needs the gh CLI (GH_TOKEN in Actions).

Usage: mirror_firmware.py [--keep N]
"""

import argparse
import datetime
import json
import pathlib
import re
import subprocess

BOARDS = {
    "tufty2350": "pimoroni/tufty2350",
    "badger2350": "pimoroni/badger2350",
    "blinky2350": "pimoroni/blinky2350",
}
IDE_TAG = re.compile(r"-ide\.\d+$")
OUT = pathlib.Path(__file__).resolve().parent.parent / "firmware"


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def assets(release):
    names = [asset["name"] for asset in release["assets"]]
    full = next((name for name in names if name.endswith("-with-filesystem.uf2")), None)
    firmware = next((name for name in names if name.endswith(".uf2") and not name.endswith("-with-filesystem.uf2")), None)
    return firmware, full


def mirror(repo, board, release):
    firmware, full = assets(release)
    if not firmware or not full:
        return None
    tag = release["tag_name"]
    target = OUT / board / tag
    target.mkdir(parents=True, exist_ok=True)
    for name in (firmware, full):
        if not (target / name).exists():
            gh("release", "download", tag, "-R", repo, "-p", name, "-D", str(target))
    base = f"firmware/{board}/{tag}/"
    return {
        "tag": tag,
        "name": release["name"] or tag,
        "published": release["published_at"],
        "url": release["html_url"],
        "firmware": base + firmware,
        "full": base + full,
    }


def board_releases(repo, board, keep):
    try:
        releases = json.loads(gh("api", f"repos/{repo}/releases?per_page=50"))
    except subprocess.CalledProcessError as error:
        print(f"{repo}: {error.stderr.strip()}")
        return {"ide": [], "stock": None}
    releases = [release for release in releases if not release["draft"]]
    ide = [release for release in releases if release["prerelease"] and IDE_TAG.search(release["tag_name"])][:keep]
    stock = next((release for release in releases if not release["prerelease"]), None)
    return {
        "ide": [entry for entry in (mirror(repo, board, release) for release in ide) if entry],
        "stock": mirror(repo, board, stock) if stock else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", type=int, default=5, help="IDE pre-releases to keep per board")
    args = parser.parse_args()

    manifest = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "boards": {board: board_releases(repo, board, args.keep) for board, repo in BOARDS.items()},
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
