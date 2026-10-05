#!/usr/bin/env python3
"""Copy Tufty 2350 firmware releases into firmware/ so the IDE can fetch them same-origin.

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

REPO = "pimoroni/tufty2350"
BOARD = "tufty2350"
IDE_TAG = re.compile(r"-ide\.\d+$")
OUT = pathlib.Path(__file__).resolve().parent.parent / "firmware"


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def assets(release):
    names = [asset["name"] for asset in release["assets"]]
    full = next((name for name in names if name.endswith("-with-filesystem.uf2")), None)
    firmware = next((name for name in names if name.endswith(".uf2") and not name.endswith("-with-filesystem.uf2")), None)
    return firmware, full


def mirror(release):
    firmware, full = assets(release)
    if not firmware or not full:
        return None
    tag = release["tag_name"]
    target = OUT / BOARD / tag
    target.mkdir(parents=True, exist_ok=True)
    for name in (firmware, full):
        if not (target / name).exists():
            gh("release", "download", tag, "-R", REPO, "-p", name, "-D", str(target))
    base = f"firmware/{BOARD}/{tag}/"
    return {
        "tag": tag,
        "name": release["name"] or tag,
        "published": release["published_at"],
        "url": release["html_url"],
        "firmware": base + firmware,
        "full": base + full,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", type=int, default=5, help="IDE pre-releases to keep")
    args = parser.parse_args()

    releases = json.loads(gh("api", f"repos/{REPO}/releases?per_page=50"))
    releases = [release for release in releases if not release["draft"]]
    ide = [release for release in releases if release["prerelease"] and IDE_TAG.search(release["tag_name"])][:args.keep]
    stock = next((release for release in releases if not release["prerelease"]), None)

    manifest = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "boards": {
            BOARD: {
                "ide": [entry for entry in (mirror(release) for release in ide) if entry],
                "stock": mirror(stock) if stock else None,
            },
        },
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
