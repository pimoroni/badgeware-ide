#!/usr/bin/env python3
"""Build a board's simulator filesystem bundle from its firmware repo.

Writes simulator/boards/<board>/filesystem/ and filesystem.json (and fonts-manifest.json)
from a git ref of the board's firmware repo, in the badge's flat LittleFS layout, plus
the simulator stubs shared with the Tufty bundle.

Usage: tools/bundle_board.py <board> <repo> [ref] [--output DIR] [--mpy-cross PATH] [--frozen] [--locals-only]

    tools/bundle_board.py badger ../badger2350
    tools/bundle_board.py blinky ../blinky2350 feature/ide-littlefs
    tools/bundle_board.py tufty ../tufty2350 HEAD --locals-only --mpy-cross ../micropython/mpy-cross/build/mpy-cross

With --mpy-cross (an mpy-cross that supports --locals) it also writes locals.json, the local
variable names of every function in the board's frozen modules, keyed by frozen path. With
--frozen it copies those frozen sources into frozen/, so a release asset carries the exact
source the firmware was built from.
"""

import argparse
import io
import json
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

FROZEN_ROOTS = ["modules/python", "modules/common"]


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


def frozen_sources(source):
    for root in FROZEN_ROOTS:
        base = source / root
        for path in sorted(base.rglob("*.py")):
            yield path, path.relative_to(base).as_posix()


def write_locals(source, mpy_cross, output):
    tables = {}
    with tempfile.TemporaryDirectory() as temp:
        compiled = pathlib.Path(temp) / "module.mpy"
        names = pathlib.Path(temp) / "locals.json"
        for path, frozen in frozen_sources(source):
            subprocess.run([mpy_cross, "-s", frozen, "-o", str(compiled), "--locals", str(names), str(path)], check=True)
            functions = json.loads(names.read_text())["functions"]
            if functions:
                tables[frozen] = functions
    (output / "locals.json").write_text(json.dumps(tables, indent=1, sort_keys=True) + "\n")
    return len(tables)


def copy_frozen(source, output):
    files = []
    for path, frozen in frozen_sources(source):
        target = output / "frozen" / frozen
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        files.append(frozen)
    (output / "frozen.json").write_text(json.dumps({"files": files}, indent=1) + "\n")


def git_output(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def write_provenance(repo, ref, board, output):
    provenance = {
        "board": board,
        "commit": git_output(repo, "rev-parse", ref),
        "version": git_output(repo, "describe", "--tags", "--always", ref),
    }
    (output / "bundle.json").write_text(json.dumps(provenance, indent=1) + "\n")
    return provenance


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
    parser.add_argument("--output", type=pathlib.Path, help="directory to write instead of simulator/boards/<board>")
    parser.add_argument("--mpy-cross", help="mpy-cross with --locals support, to write locals.json")
    parser.add_argument("--frozen", action="store_true", help="also copy the frozen module sources into frozen/")
    parser.add_argument("--locals-only", action="store_true", help="only write locals.json")
    args = parser.parse_args()

    board_dir = args.output or BOARDS / args.board
    if args.locals_only and not args.mpy_cross:
        parser.error("--locals-only needs --mpy-cross")
    if args.board == "tufty" and args.output is None and not args.locals_only:
        parser.error("the Tufty bundle carries hand-made simulator patches and contrib apps; edit it in place")

    board_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        source = pathlib.Path(temp)
        extract(args.repo, args.ref, source)
        if not args.locals_only:
            output = board_dir / "filesystem"
            shutil.rmtree(output, ignore_errors=True)
            assemble(source, output)
            add_stubs(output)
            write_manifests(board_dir)
        if args.frozen:
            shutil.rmtree(board_dir / "frozen", ignore_errors=True)
            copy_frozen(source, board_dir)
        tables = write_locals(source, args.mpy_cross, board_dir) if args.mpy_cross else 0
    provenance = write_provenance(args.repo, args.ref, args.board, board_dir)
    print(f"{args.board}: bundled {args.repo} {args.ref} ({provenance['version']}) into {board_dir}, {tables} locals tables")


if __name__ == "__main__":
    main()
