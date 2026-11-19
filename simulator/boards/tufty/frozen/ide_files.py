import binascii
import gc
import json
import micropython
import os
import sys

ACK = "\x06"
CHUNK_SIZE = 4096


def is_directory(path):
    try:
        return os.stat(path)[0] & 0x4000 != 0
    except OSError:
        return False


def _makedirs(path):
    current = ""
    for part in path.split("/"):
        if not part:
            continue
        current += "/" + part
        if not is_directory(current):
            os.mkdir(current)
def _walk(path, entries):
    for name, kind, *_ in os.ilistdir(path):
        full = path.rstrip("/") + "/" + name
        if kind == 0x4000:
            entries.append([full, -1])
            _walk(full, entries)
        else:
            entries.append([full, os.stat(full)[6]])


def info():
    total, used, free = badge.disk_free("/")
    print(json.dumps({
        "version": sys.version,
        "implementation": os.uname().machine,
        "disk": [total, used, free],
        "mem_free": gc.mem_free(),
    }))


def ls(path="/"):
    entries = []
    if is_directory(path):
        _walk(path, entries)
    print(json.dumps(entries))


def hashes(paths):
    import hashlib

    result = {}
    buf = bytearray(CHUNK_SIZE)
    for path in paths:
        try:
            digest = hashlib.sha256()
            with open(path, "rb") as f:
                while (count := f.readinto(buf)):
                    digest.update(memoryview(buf)[:count])
            result[path] = binascii.hexlify(digest.digest()).decode()
        except OSError:
            result[path] = None
    print(json.dumps(result))


def put(path, size):
    _makedirs(path.rsplit("/", 1)[0])
    buf = bytearray(CHUNK_SIZE)
    stdin = sys.stdin.buffer
    micropython.kbd_intr(-1)
    try:
        with open(path, "wb") as f:
            sys.stdout.write(ACK)
            remaining = size
            while remaining:
                view = memoryview(buf)[:min(CHUNK_SIZE, remaining)]
                received = 0
                while received < len(view):
                    received += stdin.readinto(view[received:])
                f.write(view)
                remaining -= len(view)
                sys.stdout.write(ACK)
    finally:
        micropython.kbd_intr(3)


def get(path):
    buf = bytearray(768)
    with open(path, "rb") as f:
        while (count := f.readinto(buf)):
            sys.stdout.write(binascii.b2a_base64(memoryview(buf)[:count]))


def rm(path):
    if is_directory(path):
        for name, *_ in os.ilistdir(path):
            rm(path.rstrip("/") + "/" + name)
        os.rmdir(path)
    else:
        os.remove(path)


def mkdir(path):
    _makedirs(path)


def rename(source, destination):
    _makedirs(destination.rsplit("/", 1)[0])
    os.rename(source, destination)
