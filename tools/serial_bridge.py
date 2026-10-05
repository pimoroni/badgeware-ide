#!/usr/bin/env python3
"""Pipe a serial port to stdin/stdout, for driving the IDE's device code from node tests.

Usage: serial_bridge.py PORT
"""

import os
import selectors
import sys

import serial


def main():
    port = serial.Serial(sys.argv[1], 115200, timeout=0)
    port.dtr = True
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin.buffer, selectors.EVENT_READ)
    selector.register(port, selectors.EVENT_READ)
    stdout = sys.stdout.buffer
    while True:
        for key, _ in selector.select():
            if key.fileobj is port:
                data = port.read(port.in_waiting or 1)
                if data:
                    stdout.write(data)
                    stdout.flush()
            else:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    return
                port.write(data)


if __name__ == "__main__":
    main()
