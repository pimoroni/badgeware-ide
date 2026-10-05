import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { romfsPaths } from '../simulator/device/romfs.js';

const MPREMOTE = process.env.MPREMOTE_DIR || '../tufty2350-ide/build/micropython/tools/mpremote';

test('lists files in an mpremote-built ROMFS image', { skip: !existsSync(MPREMOTE) && 'mpremote not found' }, () => {
  const image = execFileSync('python3', ['-c', `
import sys, os, tempfile
sys.path.insert(0, ${JSON.stringify(MPREMOTE)})
from mpremote.romfs import VfsRomWriter
w = VfsRomWriter()
w.opendir("fonts"); w.mkfile("a.ppf", b"x" * 300); w.mkfile("b.ppf", b"y"); w.closedir()
w.mkfile("top.txt", b"hello")
sys.stdout.buffer.write(w.finalise())
`]);
  assert.deepEqual(romfsPaths(new Uint8Array(image)), ['fonts/a.ppf', 'fonts/b.ppf', 'top.txt']);
});

test('ignores data that is not ROMFS', () => {
  assert.deepEqual(romfsPaths(new Uint8Array(64).fill(0xff)), []);
});
