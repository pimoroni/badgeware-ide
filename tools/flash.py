#!/usr/bin/env python3
"""Reboot a Tufty into BOOTSEL over its REPL port and load a .uf2 with picotool.

Usage: flash.py REPL_PORT FIRMWARE.uf2
"""

import subprocess
import sys
import time

import serial


def main():
    port, firmware = sys.argv[1:3]
    with serial.Serial(port, 115200, timeout=1) as connection:
        connection.dtr = True
        connection.write(b"\x03\x03")
        time.sleep(0.2)
        connection.write(b"\r\x02import machine; machine.bootloader()\r")
        time.sleep(0.2)
    for _ in range(50):
        if subprocess.run(["picotool", "info"], capture_output=True).returncode == 0:
            break
        time.sleep(0.2)
    sys.exit(subprocess.run(["picotool", "load", "-x", firmware]).returncode)


if __name__ == "__main__":
    main()
