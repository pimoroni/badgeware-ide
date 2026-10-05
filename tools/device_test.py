#!/usr/bin/env python3
"""Hardware tests for the Tufty IDE firmware protocol.

Usage: device_test.py REPL_PORT DEBUG_PORT

Needs pyserial and mpremote (from the MicroPython checkout's tools/mpremote).
"""

import hashlib
import json
import os
import sys
import threading
import time

import serial
from mpremote.transport_serial import SerialTransport

APP_DIR = "/system/apps/ide_test"
APP_FILE = APP_DIR + "/__init__.py"

ERROR_APP = """\
def update():
    screen.clear()
    return 1 / 0

run(update)
"""

DEBUG_APP = """\
counter = 0
items = [1, 2, 3]

def bump():
    global counter
    counter += 1

def update():
    bump()
    label = str(counter)
    screen.text(label, 10, 10)
    if counter >= 5:
        return True

run(update)
"""

failures = []


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (f" ({detail})" if detail and not condition else ""))
    if not condition:
        failures.append(name)


def put(transport, path, data):
    transport.exec_raw_no_follow(f"import ide; ide.put({path!r}, {len(data)})")
    assert transport.serial.read(1) == b"\x06", "no ready ack"
    for offset in range(0, len(data), 4096):
        transport.serial.write(data[offset:offset + 4096])
        assert transport.serial.read(1) == b"\x06", "no chunk ack"
    out, err = transport.follow(5)
    assert not err, err


def exec_json(transport, code):
    return json.loads(transport.exec(code).decode())


def test_files(transport):
    payload = bytes(range(256)) * 40 + os.urandom(3000) + b"\x03\x04\x01\x02"
    started = time.monotonic()
    put(transport, "/ide_test.bin", payload)
    elapsed = time.monotonic() - started
    print(f"     put {len(payload)} bytes in {elapsed:.2f}s ({len(payload) / elapsed / 1024:.1f} KiB/s)")
    hashes = exec_json(transport, "import ide; ide.hashes(['/ide_test.bin', '/missing'])")
    check("put + hashes", hashes["/ide_test.bin"] == hashlib.sha256(payload).hexdigest())
    check("hashes missing file", hashes["/missing"] is None)
    import binascii
    raw = transport.exec("import ide; ide.get('/ide_test.bin')")
    received = b"".join(binascii.a2b_base64(line) for line in raw.split(b"\n") if line.strip())
    check("get", received == payload)
    listing = exec_json(transport, "import ide; ide.ls('/')")
    check("ls", ["/ide_test.bin", len(payload)] in listing)
    transport.exec("import ide; ide.rm('/ide_test.bin')")


def test_error_line(transport):
    put(transport, APP_FILE, ERROR_APP.encode())
    out = transport.exec(f"import ide; ide.execute({APP_DIR!r})").decode()
    expected = f'File "{APP_FILE}", line 3'
    check("traceback has app line", expected in out, out)
    check("traceback header", "Traceback (most recent call last):" in out, out)
    check("exception line", "ZeroDivisionError" in out, out)


class DebugChannel:
    def __init__(self, port):
        self.serial = serial.Serial(port, 115200, timeout=0.1)
        self.serial.dtr = True
        self.buffer = b""

    def send(self, message):
        self.serial.write((json.dumps(message) + "\n").encode())

    def receive(self, event, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                message = json.loads(line)
                if message.get("event") == event:
                    return message
            self.buffer += self.serial.read(256)
        raise TimeoutError(f"no {event} event")


def test_debugger(transport, debug_port):
    put(transport, APP_FILE, DEBUG_APP.encode())
    channel = DebugChannel(debug_port)
    output = []

    def follow():
        output.append(transport.follow(30))

    transport.exec_raw_no_follow(f"import ide; ide.execute({APP_DIR!r}, debug=True)")
    follower = threading.Thread(target=follow)
    follower.start()

    channel.receive("ready")
    channel.send({"cmd": "init", "breakpoints": {APP_FILE: [9]}})

    stopped = channel.receive("stopped")
    top = stopped["stack"][0]
    check("breakpoint hit", stopped["reason"] == "breakpoint" and top["file"] == APP_FILE and top["line"] == 9, stopped)
    check("stack names", [f["name"] for f in stopped["stack"]][:1] == ["update"], stopped["stack"])

    channel.send({"cmd": "scopes", "frame": 0})
    scopes = channel.receive("scopes")
    variables = {v["name"]: v for v in scopes["globals"]}
    check("globals counter", variables.get("counter", {}).get("value") == "0", variables)
    check("globals list ref", variables.get("items", {}).get("ref", 0) > 0, variables)

    channel.send({"cmd": "expand", "ref": variables["items"]["ref"]})
    children = channel.receive("children")["children"]
    check("expand list", [c["value"] for c in children] == ["1", "2", "3"], children)

    channel.send({"cmd": "stepIn"})
    stopped = channel.receive("stopped")
    check("step in to bump", stopped["stack"][0]["name"] == "bump", stopped["stack"][0])

    channel.send({"cmd": "stepOut"})
    stopped = channel.receive("stopped")
    check("step out to update", stopped["stack"][0]["name"] == "update" and stopped["stack"][0]["line"] == 10, stopped["stack"][0])

    channel.send({"cmd": "stepOver"})
    stopped = channel.receive("stopped")
    check("step over", stopped["stack"][0]["line"] == 11, stopped["stack"][0])

    channel.send({"cmd": "scopes", "frame": 0})
    scopes = channel.receive("scopes")
    local_values = {v["name"]: v["value"] for v in scopes["locals"] or []}
    check("locals in a function", local_values == {"label": "'1'"}, scopes["locals"])
    channel.send({"cmd": "scopes", "frame": len(stopped["stack"]) - 1})
    check("no locals at module level", channel.receive("scopes")["locals"] is None)
    channel.send({"cmd": "eval", "expr": "label + '!'", "id": 3})
    check("eval sees locals", channel.receive("evaluated").get("result", {}).get("value") == "'1!'")

    channel.send({"cmd": "eval", "expr": "counter * 10", "id": 1})
    evaluated = channel.receive("evaluated")
    check("eval", evaluated.get("result", {}).get("value") == "10", evaluated)

    channel.send({"cmd": "continue"})
    stopped = channel.receive("stopped")
    channel.send({"cmd": "eval", "expr": "counter", "id": 2})
    check("continue to breakpoint", channel.receive("evaluated").get("result", {}).get("value") == "1")

    channel.send({"cmd": "setBreakpoints", "file": APP_FILE, "lines": []})
    channel.send({"cmd": "continue"})
    channel.receive("terminated", timeout=10)
    follower.join(10)
    check("app finished", output and output[0][1] == b"", output)
    channel.serial.close()


LOOP_APP = """\
import time

count = 0
while True:
    count += 1
    print("Hello")
    time.sleep_ms(300)
"""


def test_pause_plain_loop(transport, debug_port):
    put(transport, APP_FILE, LOOP_APP.encode())
    channel = DebugChannel(debug_port)
    transport.exec_raw_no_follow(f"import ide; ide.execute({APP_DIR!r}, debug=True)")
    channel.receive("ready")
    channel.send({"cmd": "init", "breakpoints": {}})
    time.sleep(0.5)
    ticks = []
    for request_id in (10, 11):
        channel.send({"cmd": "eval", "expr": "time.ticks_ms()", "id": request_id})
        ticks.append(channel.receive("evaluated").get("result", {}).get("value"))
        time.sleep(0.4)
    check("eval while running updates", None not in ticks and ticks[0] != ticks[1], ticks)
    started = time.monotonic()
    channel.send({"cmd": "pause"})
    stopped = channel.receive("stopped", timeout=3)
    check("pause in a plain loop", stopped["reason"] == "pause" and stopped["stack"][0]["file"] == APP_FILE, stopped)
    print(f"     paused after {time.monotonic() - started:.2f}s")
    started = time.monotonic()
    channel.send({"cmd": "screen", "id": "s"})
    header = channel.receive("screen", timeout=10)
    deadline = time.monotonic() + 10
    while len(channel.buffer) < header["bytes"] and time.monotonic() < deadline:
        channel.buffer += channel.serial.read(65536)
    size = min(len(channel.buffer), header["bytes"])
    channel.buffer = channel.buffer[header["bytes"]:]
    print(f"     screen {header['width']}x{header['height']} in {time.monotonic() - started:.2f}s")
    check("screen capture", size == header["width"] * header["height"] * 4, size)
    transport.serial.write(b"\x03")
    channel.receive("terminated")
    transport.follow(5)
    channel.serial.close()


def test_interrupt_while_stopped(transport, debug_port):
    put(transport, APP_FILE, DEBUG_APP.encode())
    channel = DebugChannel(debug_port)
    transport.exec_raw_no_follow(f"import ide; ide.execute({APP_DIR!r}, debug=True)")
    channel.receive("ready")
    channel.send({"cmd": "init", "breakpoints": {APP_FILE: [6]}})
    channel.receive("stopped")
    transport.serial.write(b"\x03")
    channel.receive("terminated")
    out, err = transport.follow(5)
    check("ctrl-c while stopped", b"KeyboardInterrupt" in err, err)
    channel.serial.close()


def main():
    repl_port, debug_port = sys.argv[1:3]
    transport = SerialTransport(repl_port, baudrate=115200)
    transport.enter_raw_repl(soft_reset=True)
    try:
        test_files(transport)
        test_error_line(transport)
        test_debugger(transport, debug_port)
        test_pause_plain_loop(transport, debug_port)
        test_interrupt_while_stopped(transport, debug_port)
        transport.exec(f"import ide; ide.rm({APP_DIR!r})")
    finally:
        transport.exit_raw_repl()
        transport.close()
    print(f"{len(failures)} failure(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
