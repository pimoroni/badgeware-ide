# Badgeware IDE

Prototype in-browser IDE for Badgeware badges. Code runs on a real badge over USB by default, with the simulator as an option for anyone without one.

Seeded from badgeware-web (f565ab7). Tufty 2350 only for now.

## Running

```sh
./start_server.py --cross 8000
```

Open http://localhost:8000 in Chrome or Edge (Web Serial). Other browsers fall back to the simulator.

The badge needs the IDE firmware: `feature/ide-littlefs` of tufty2350, built against the `bw-1.29.0-ide` MicroPython branch.

## How it works

The badge exposes two USB CDC interfaces:

- **Tufty REPL**: raw REPL. The IDE soft resets into a clean VM, reads and writes files with `ide.get` / `ide.put`, and runs apps with `ide.execute()`. Tracebacks stream back and are mapped onto editor lines.
- **Tufty Debug**: when idle, answers Ctrl-C with a JSON ident (`model`, `board`, `protocol`, `firmware`, `features`). The IDE uses this to tell the two ports apart and to reject incompatible badges, since VID/PID alone is shared with customised variants. During a debug session `ide_debug` claims the port and speaks newline-delimited JSON (breakpoints, step, stack, globals, eval) on top of `sys.settrace`.

The editor has two modes, picked from the toolbar (`?mode=badge|simulator`, remembered):

- **Badge**: the Files tree is the badge's filesystem. Files load when opened and save straight back to the badge (held while an app runs, flushed before the next Run). `/rom` is read-only. New apps go in `/system/apps/<slug>/`, so they show up in the launcher. The side panel is the debugger plus output; there's no simulator.
- **Simulator**: the browser workspace (IndexedDB) and the 3D simulator. Apps live in `/apps/<slug>/` and run with `launch()`.

"Copy from simulator" (Files header) and "Copy to simulator" (context menu) move apps between the two; `/apps/<slug>` maps to `/system/apps/<slug>`. Unsaved tabs run on the badge as `/.ide/scratch.py`.

| File | Role |
|---|---|
| `simulator/device/serial-link.js` | Byte stream over a Web Serial shaped port |
| `simulator/device/raw-repl.js` | Raw REPL client |
| `simulator/device/badge.js` | Port identification, compatibility, sync, run, stop, debug sessions |
| `simulator/device/debug.js` | Debug channel client |
| `simulator/device/paths.js` | Editor path to badge path mapping |
| `simulator/device/badge-fs.js` | Badge filesystem backend for the editor |
| `simulator/device/session.js` | Badge mode device + backend setup |
| `simulator/mode.js` | Badge / Simulator mode |
| `simulator/target.js` | Badge mode connect, run, copy between modes |
| `simulator/debugger.js` | Breakpoints (F9), debug panel |
| `simulator/icon-editor.js` | 24 x 24 icon editor |
| `simulator/app-scaffold.js` | New app template |
| `simulator/png.js` | Merge IDAT chunks (PNGdec on the badge fails on split IDATs) |

Keys: F5 run, F6 debug, F9 toggle breakpoint.

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
tools/flash.py <repl> firmware.uf2                     # reboot to BOOTSEL and load
```

`e2e-badge.mjs` injects `test/web-serial-shim.js` as `navigator.serial`, tunnelled through the bridge.
