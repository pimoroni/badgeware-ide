#!/usr/bin/env python3
"""Build a board's simulator filesystem bundle from its firmware repo.

Writes simulator/boards/<board>/filesystem/ and filesystem.json (and fonts-manifest.json)
from a git ref of the board's firmware repo, in the badge's flat LittleFS layout, plus
the simulator stubs shared with the Tufty bundle.

Usage: tools/bundle_board.py <board> <repo> [ref]

    tools/bundle_board.py badger ../badger2350
    tools/bundle_board.py blinky ../blinky2350 feature/ide-littlefs
"""

import argparse
import io
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOARDS = ROOT / "simulator" / "boards"
STUB_SOURCE = BOARDS / "tufty" / "filesystem"

sys.path.insert(0, str(ROOT))
from generate_manifest import write_manifests  # noqa: E402

LAYOUT = [
    ("firmware/apps", "apps"),
    ("firmware/fonts", "fonts"),
    ("firmware/assets", "assets"),
    ("modules/common/badgeware", "badgeware"),
    ("romfs", "rom"),
]

SIMULATOR_FILES = [
    "badgeware/rtc.py",
    "breakout_bme280.py",
    "breakout_ltr559.py",
    "lsm6ds3.py",
    "pcf85063a.py",
    "powman.py",
    "qwstpad.py",
    "secrets.py",
]

GENERATED_STUBS = {
    "cdcaux.py": "def app(path):\n    pass\n",
}

REWRITES = [
    (".frozen/badgeware/", "badgeware/"),
]


def source_paths():
    return sorted({source.split("/")[0] for source, _ in LAYOUT})


def destination(relative):
    for prefix, target in LAYOUT:
        if relative == prefix or relative.startswith(prefix + "/"):
            return f"{target}{relative[len(prefix):]}"
    return None


def rewrite(text):
    for old, new in REWRITES:
        text = text.replace(old, new)
    return text


def extract(repo, ref, target):
    archive = subprocess.run(["git", "-C", str(repo), "archive", ref, *source_paths()], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(target, filter="data")


def assemble(source, output):
    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        mapped = destination(path.relative_to(source).as_posix())
        if mapped is None:
            continue
        target = output / mapped
        target.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix == ".py":
            target.write_text(rewrite(path.read_text()))
        else:
            shutil.copyfile(path, target)


def add_stubs(output):
    for name in SIMULATOR_FILES:
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(STUB_SOURCE / name, target)
    for name, text in GENERATED_STUBS.items():
        (output / name).write_text(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("board", help="board id, eg: badger")
    parser.add_argument("repo", help="firmware git repository, eg: ../badger2350")
    parser.add_argument("ref", nargs="?", default="feature/ide-littlefs", help="git ref to bundle")
    args = parser.parse_args()

    if args.board == "tufty":
        parser.error("the Tufty bundle carries hand-made simulator patches and contrib apps; edit it in place")

    board_dir = BOARDS / args.board
    output = board_dir / "filesystem"
    shutil.rmtree(output, ignore_errors=True)
    with tempfile.TemporaryDirectory() as temp:
        source = pathlib.Path(temp)
        extract(args.repo, args.ref, source)
        assemble(source, output)
    add_stubs(output)
    write_manifests(board_dir)
    commit = subprocess.run(["git", "-C", str(args.repo), "rev-parse", "--short", args.ref], check=True, capture_output=True, text=True).stdout.strip()
    print(f"{args.board}: bundled {args.repo} {args.ref} ({commit})")


if __name__ == "__main__":
    main()
