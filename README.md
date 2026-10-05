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

There is one workspace (IndexedDB) and one set of open tabs. The Badge / Simulator switch on the right of the toolbar picks where Run goes:

- **Badge**: Run syncs changed workspace files to the badge (by SHA-256) and runs there. `/apps/<slug>` maps to `/system/apps/<slug>`, so apps show up in the launcher; other files keep their path; `/secrets.py` is never synced. Unsaved tabs run as `/.ide/scratch.py`. The side panel is the debugger plus output.
- **Simulator**: the 3D simulator. Apps run with `launch()`.

The Files panel shows the workspace on top and the badge's own files below. Badge files open read-only; the context menus copy files and folders either way, and delete from the badge. **Config** edits `/secrets.py` on the badge (WiFi, region, GMT offset, custom keys) and needs the Badge target.

| File | Role |
|---|---|
| `simulator/device/serial-link.js` | Byte stream over a Web Serial shaped port |
| `simulator/device/raw-repl.js` | Raw REPL client |
| `simulator/device/badge.js` | Port identification, compatibility, sync, run, stop, debug sessions |
| `simulator/device/debug.js` | Debug channel client |
| `simulator/device/paths.js` | Editor path to badge path mapping |
| `simulator/device/badge-fs.js` | The badge's file listing, lazy reads and writes |
| `simulator/device/session.js` | Shared badge device and filesystem |
| `simulator/mode.js` | Badge / Simulator target switch |
| `simulator/target.js` | Badge connect and pairing, run and debug on the badge, copying |
| `simulator/config-pane.js`, `simulator/secrets-file.js` | Config pane and the secrets.py reader/writer |
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
