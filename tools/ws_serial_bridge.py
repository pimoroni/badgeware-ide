#!/usr/bin/env python3
"""Expose local serial ports over WebSocket, for browser tests without Web Serial.

Usage: ws_serial_bridge.py [PORT_NUMBER]
Connect to ws://localhost:PORT_NUMBER/dev/cu.usbmodemXXXX
"""

import asyncio
import sys

import serial
import websockets


owners = {}


async def handle(websocket):
    device = websocket.request.path
    previous = owners.get(device)
    if previous is not None:
        print(f"{device}: taking over from previous owner", flush=True)
        previous.cancel()
        await asyncio.wait([previous])
    owners[device] = asyncio.current_task()
    print(f"{device}: open", flush=True)
    port = serial.Serial(device, 115200, timeout=0)
    port.dtr = True
    loop = asyncio.get_running_loop()
    readable = asyncio.Event()
    loop.add_reader(port.fileno(), readable.set)

    async def pump_serial():
        while True:
            await readable.wait()
            readable.clear()
            data = port.read(port.in_waiting or 1)
            if data:
                await websocket.send(data)

    pump = asyncio.create_task(pump_serial())
    try:
        async for message in websocket:
            port.write(message if isinstance(message, bytes) else message.encode())
    except (websockets.ConnectionClosed, asyncio.CancelledError):
        pass
    finally:
        pump.cancel()
        loop.remove_reader(port.fileno())
        port.close()
        if owners.get(device) is asyncio.current_task():
            del owners[device]
        print(f"{device}: closed", flush=True)


async def main():
    async with websockets.serve(handle, "localhost", int(sys.argv[1]) if len(sys.argv) > 1 else 8765, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
