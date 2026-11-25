# Badgeware IDE

Prototype in-browser IDE for Badgeware badges. Code runs on a real badge over USB by default, with the simulator as an option for anyone without one.

Seeded from badgeware-web (f565ab7). Supports Tufty 2350, Badger 2350 and Blinky 2350.

## Running

```sh
./start_server.py --cross 8000
```

Open http://localhost:8000 in Chrome or Edge (Web Serial). Other browsers fall back to the simulator.

The badge needs the IDE firmware: `feature/ide-littlefs` of tufty2350, badger2350 or blinky2350, built against the `bw-1.29.0-ide` MicroPython branch.

## How it works

The badge exposes two USB CDC interfaces:

- **REPL**: raw REPL. The IDE soft resets into a clean VM, reads and writes files with `ide.get` / `ide.put`, and runs apps with `ide.execute()`. Tracebacks stream back and are mapped onto editor lines.
- **Debug**: when idle, answers Ctrl-C with a JSON ident (`model`, `board`, `protocol`, `firmware`, `features`). The IDE uses this to tell the two ports apart and to reject incompatible badges, since VID/PID alone is shared with customised variants. During a debug session `ide_debug` claims the port and speaks newline-delimited JSON (breakpoints, step, stack, globals, eval) on top of `sys.settrace`.

There is one workspace and one set of open tabs. The workspace lives in IndexedDB, or in a local folder opened from the Workspace header (File System Access API, Chromium only). A local folder is reread when the window gets focus; dotfiles, `node_modules` and `__pycache__` are skipped. The Badge / Simulator switch on the right of the toolbar picks where Run goes:

- **Badge**: Run syncs changed workspace files to the badge (by SHA-256) and runs there. Paths are the same on both: apps live in `/apps/<slug>`, which the launcher scans. `/secrets.py` is never synced. Unsaved tabs run as `/.ide/scratch.py`. The side panel is the debugger plus output.
- **Simulator**: the 3D simulator. Apps run with `launch()`.

The Files panel shows the workspace on top and the badge's own files below. Badge files open read-only; the context menus copy files and folders either way, and delete from the badge. **Config** edits `/secrets.py` on the badge (WiFi, region, GMT offset, custom keys) and needs the Badge target. Config and the badge tree's context menu also back up the badge to a .zip and restore one.

## Boards

`simulator/boards.js` describes each board: ident model, USB product id, screen size and kind, simulator build and bundle, workspace stores, firmware manifest key and flash layout, and the 3D model. The active board is stored in localStorage (`badgeware.board`, or `?board=badger` in the URL). With a badge connected it follows the badge's ident; otherwise the toolbar's board picker sets it. Changing board reloads the page.

Each board keeps its own browser workspace and open tabs (IndexedDB `badgeware.userfs.<board>`, `badgeware.session.<board>`; Tufty keeps the original `badgeware.userfs` and `badgeware.session`). Completions are one shared set in `simulator/completions.js`; entries tagged `boards: [...]` apply to those boards only and `BOARD_OVERRIDES` replaces or adds per-board entries. Examples in `simulator/examples/manifest.json` take the same `boards` tag.

Simulator builds and bundles live in `simulator/boards/<board>/`: `jspi/` and `asyncify/` (`micropython.{mjs,wasm}` from badgeware-wasm `build-<board>2350-{jspi,asyncify}`), `filesystem/`, `filesystem.json`, `fonts-manifest.json`, and the debug tables `frozen/`, `frozen.json` and `bundle.json`. Each is a firmware debug bundle (badgeware-debug's `tools/bundle.py`, published with each firmware release as `<board>-<version>-micropython-simulator.zip`) with badgeware-wasm's simulator overlay on top:

```sh
tools/import_bundle.py badger ../badger2350-bundle ../web/badgeware-wasm/simulator/overlay
tools/import_bundle.py tufty tufty-v3.2.0-micropython-simulator.zip ../web/badgeware-wasm/simulator/overlay
```

This replaces `filesystem/` and the debug tables, copies `overlay/common/` and then `overlay/<board>2350/` over the filesystem (simulator stand-ins such as `powman` and `rtc`, a `cdcaux` stub, and Tufty's patched and contrib apps), and regenerates the manifests. Change the overlay in badgeware-wasm rather than editing a bundle in place.

The 3D view uses `static/models/badgeware.glb` for Tufty (with button and case-light markers) and `static/models/badgeware-boards.glb` (badgeware-website's `badgeware-compressed.glb`) for Badger and Blinky, which have keyboard input only.

| File | Role |
|---|---|
| `simulator/boards.js` | Board profiles and the active board |
| `simulator/screens.js` | E-ink and LED screen rendering for the 3D view |
| `simulator/device/serial-link.js` | Byte stream over a Web Serial shaped port |
| `simulator/device/raw-repl.js` | Raw REPL client |
| `simulator/device/badge.js` | Port identification, compatibility, connection lifecycle |
| `simulator/device/transport.js` | Shared transport queue and raw REPL file and ROM commands |
| `simulator/device/repl-transport.js` | Files, runs and debug sessions over the raw REPL (older firmware) |
| `simulator/device/aux-transport.js` | Files, runs and debug sessions over the aux link |
| `simulator/device/debug.js` | Debug channel client |
| `simulator/device/paths.js` | Editor path to badge path mapping |
| `simulator/device/badge-fs.js` | The badge's file listing, lazy reads and writes |
| `simulator/device/session.js` | Shared badge device and filesystem |
| `simulator/device/backup.js`, `simulator/backup-dialog.js`, `simulator/zip.js` | Badge backup and restore as a .zip |
| `simulator/mode.js` | Badge / Simulator target switch |
| `simulator/workspace.js`, `simulator/local-fs.js` | Local folder workspace |
| `simulator/target.js` | Badge connect and pairing, run and debug on the badge, copying |
| `simulator/config-pane.js`, `simulator/secrets-file.js` | Config pane and the secrets.py reader/writer |
| `simulator/debugger.js` | Breakpoints (F9), debug panel |
| `simulator/debug-sources.js` | Stack frame to source mapping, opening sources, frozen and locals tables from the board bundle |
| `simulator/icon-editor.js` | 24 x 24 icon editor |
| `simulator/app-scaffold.js` | New app template |
| `simulator/png.js` | Merge IDAT chunks (PNGdec on the badge fails on split IDATs) |

Keys: F5 run, F6 debug, F9 toggle breakpoint.

## Firmware

Config > Manage firmware installs firmware over WebUSB (the RP2350 bootloader's PICOBOOT interface): update to the latest IDE pre-release (keeps files), a fresh install, switching back to stock, or a local .uf2. Connecting a badge on stock firmware opens it automatically.

Firmware comes from `pimoroni/tufty2350`, `pimoroni/badger2350` and `pimoroni/blinky2350` releases. GitHub's release downloads have no CORS headers, so `.github/workflows/pages.yml` runs `tools/mirror_firmware.py`, which copies each board's latest IDE pre-releases (tags ending `-ide.N`) and latest stock release into `firmware/` with a `manifest.json`, and deploys that alongside the site. It runs on push, every six hours, on demand, and on a `firmware-released` repository_dispatch.

To publish a new IDE firmware:

```sh
gh release create v4.0.0-ide.N -R pimoroni/<board>2350 --target feature/ide-littlefs --prerelease --title "Badgeware IDE preview N" --notes "..."
# once its CI has attached the .uf2 files:
gh workflow run pages.yml -R pimoroni/badgeware-ide
```

## Tests

```sh
npm test                                              # unit tests; hardware tests skip
BADGE_PORTS=<repl>,<debug> BADGE_PYTHON=<python with pyserial> npm test
```

Hardware and browser checks:

```sh
tools/device_test.py <repl> <debug>                   # firmware protocol (pyserial + mpremote)
tools/ws_serial_bridge.py 8799 &                       # serial over WebSocket
./start_server.py --cross 8123 &
BRIDGE_URL=ws://localhost:8799 IDE_URL=http://localhost:8123/index.html \
  BADGE_PORTS=<repl>,<debug> node tools/e2e-badge.mjs  # drives the real page against the badge
tools/flash.py <repl> firmware.uf2                     # reboot to BOOTSEL and load with picotool
BADGE_FLASH=firmware.uf2 BADGE_PORTS=<repl>,<debug> npm test  # also flashes through simulator/device/picoboot.js
```

`e2e-badge.mjs` injects `test/web-serial-shim.js` as `navigator.serial`, tunnelled through the bridge.
