import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, createZip, readZip } from '../simulator/zip.js';

const encode = (text) => new TextEncoder().encode(text);

test('crc32 matches the reference value', () => {
  assert.equal(crc32(encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zip round trip keeps paths and bytes', async () => {
  const random = Uint8Array.from({ length: 300 }, (_, index) => (index * 7919 + 13) % 251);
  const files = [
    { path: 'apps/' },
    { path: 'apps/clock/__init__.py', bytes: encode('import time\n'.repeat(200)) },
    { path: 'apps/clock/icon.png', bytes: random },
    { path: 'empty.txt', bytes: new Uint8Array(0) },
    { path: 'café.txt', bytes: encode('hello') },
  ];
  const zip = await createZip(files, { date: new Date(2026, 10, 17, 12, 30, 10) });
  const read = await readZip(zip);
  assert.deepEqual(read.map((file) => file.path), files.map((file) => file.path));
  assert.equal(read[0].isDir, true);
  for (const [index, file] of files.entries()) assert.deepEqual(read[index].bytes, file.bytes ?? new Uint8Array(0));
});

test('compressible files are deflated and others are stored', async () => {
  const text = encode('a'.repeat(4096));
  const noise = Uint8Array.from({ length: 64 }, (_, index) => (index * 73 + 41) & 0xff);
  const zip = await createZip([{ path: 'a.txt', bytes: text }, { path: 'b.bin', bytes: noise }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint16(8, true), 8);
  const second = 30 + 'a.txt'.length + view.getUint32(18, true);
  assert.equal(view.getUint16(second + 8, true), 0);
  assert.ok(zip.length < text.length);
});

test('corrupt data fails the CRC check', async () => {
  const zip = await createZip([{ path: 'a.txt', bytes: encode('hello world') }]);
  zip[30 + 'a.txt'.length] ^= 0xff;
  await assert.rejects(readZip(zip), /CRC|damaged|invalid|incorrect/i);
});

test('non-zip input is rejected', async () => {
  await assert.rejects(readZip(encode('not a zip at all, just some text')), /not a zip/);
});
