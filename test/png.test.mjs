import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { mergeIdat, pngChunks } from '../simulator/png.js';

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function splitPng(raw, sizes) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const compressed = deflateSync(raw);
  const parts = [];
  let offset = 0;
  for (const size of sizes) {
    parts.push(chunk('IDAT', compressed.subarray(offset, offset + size)));
    offset += size;
  }
  parts.push(chunk('IDAT', compressed.subarray(offset)));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('sRGB', [0]), ...parts, chunk('IEND', [])]));
}

test('merges split IDAT chunks into one with valid CRCs', () => {
  const raw = Buffer.alloc(4 * (1 + 16), 7);
  const png = splitPng(raw, [10, 5]);
  assert.equal(pngChunks(png).filter((c) => c.type === 'IDAT').length, 3);
  const merged = mergeIdat(png);
  const chunks = pngChunks(merged);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'sRGB', 'IDAT', 'IEND']);
  assert.deepEqual(inflateSync(chunks[2].data), raw);
  const view = Buffer.from(merged);
  let offset = 8;
  for (const c of chunks) {
    const length = view.readUInt32BE(offset);
    assert.equal(view.readUInt32BE(offset + 8 + length), crc32(view.subarray(offset + 4, offset + 8 + length)));
    offset += 12 + length;
  }
});

test('leaves single IDAT files alone', () => {
  const png = splitPng(Buffer.alloc(68, 1), []);
  assert.equal(mergeIdat(png), png);
});
