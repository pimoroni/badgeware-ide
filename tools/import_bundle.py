#!/usr/bin/env python3
import argparse
import pathlib
import shutil
import sys
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOARDS = ROOT / "simulator" / "boards"
MODELS = {"tufty": "tufty2350", "badger": "badger2350", "blinky": "blinky2350"}
BUNDLE_DIRS = ["filesystem", "frozen"]
BUNDLE_FILES = ["frozen.json", "bundle.json"]
IGNORE = shutil.ignore_patterns(".DS_Store", "__pycache__")

sys.path.insert(0, str(ROOT))
from generate_manifest import write_manifests  # noqa: E402


def import_bundle(board, bundle, overlay_root, board_dir):
    board_dir.mkdir(parents=True, exist_ok=True)
    for name in BUNDLE_DIRS:
        shutil.rmtree(board_dir / name, ignore_errors=True)
        shutil.copytree(bundle / name, board_dir / name, ignore=IGNORE)
    for name in BUNDLE_FILES:
        shutil.copyfile(bundle / name, board_dir / name)
    for overlay in (overlay_root / "common", overlay_root / MODELS[board]):
        if overlay.is_dir():
            shutil.copytree(overlay, board_dir / "filesystem", ignore=IGNORE, dirs_exist_ok=True)
    write_manifests(board_dir)


def main():
    parser = argparse.ArgumentParser(description="Build simulator/boards/<board>/ from a firmware debug bundle and badgeware-wasm's simulator overlay.")
    parser.add_argument("board", choices=sorted(MODELS), help="board id")
    parser.add_argument("bundle", type=pathlib.Path, help="firmware debug bundle: a directory or a -simulator.zip")
    parser.add_argument("overlay", type=pathlib.Path, help="badgeware-wasm simulator/overlay directory")
    parser.add_argument("--output", type=pathlib.Path, help="directory to write instead of simulator/boards/<board>")
    args = parser.parse_args()

    board_dir = args.output or BOARDS / args.board
    with tempfile.TemporaryDirectory() as temp:
        bundle = args.bundle
        if bundle.suffix == ".zip":
            with zipfile.ZipFile(bundle) as archive:
                archive.extractall(temp)
            bundle = pathlib.Path(temp)
        import_bundle(args.board, bundle, args.overlay, board_dir)
    print(f"{args.board}: imported {args.bundle} with {args.overlay} into {board_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
