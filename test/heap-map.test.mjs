import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREE, HEAD, TAIL, heapMap, hexDump } from '../simulator/heap-map.js';

const pack = (kinds) => Uint8Array.from({ length: kinds.length / 4 }, (_, i) => kinds.slice(i * 4, i * 4 + 4).reduce((byte, kind, slot) => byte | (kind << (slot * 2)), 0));

test('decodes an allocation table into usage and fragmentation', () => {
  const kinds = [HEAD, TAIL, TAIL, FREE, FREE, HEAD, FREE, FREE, FREE, FREE, FREE, FREE];
  const map = heapMap(pack(kinds), 16);
  assert.deepEqual([...map.kinds], kinds);
  assert.equal(map.allocations, 2);
  assert.equal(map.usedBytes, 4 * 16);
  assert.equal(map.freeBytes, 8 * 16);
  assert.equal(map.largestFreeBytes, 6 * 16);
  assert.equal(map.fragmentation, 1 - 6 / 8);
});

test('hex dumps rows with addresses and printable text', () => {
  const dump = hexDump(new TextEncoder().encode('Badgeware! 0123456789'), 0x20001000, 8);
  assert.equal(dump.split('\n')[0], '20001000  42 61 64 67 65 77 61 72  Badgewar');
  assert.equal(dump.split('\n').length, 3);
});

test('offsets into a region become addresses', async () => {
  const { DEFAULT_REGIONS, regionAddress } = await import('../simulator/heap-map.js');
  assert.equal(regionAddress(DEFAULT_REGIONS, 'sram', '0', 128), 0x20000000);
  assert.equal(regionAddress(DEFAULT_REGIONS, 'flash', '0x300000', 16), 0x10300000);
  assert.equal(regionAddress(DEFAULT_REGIONS, 'psram', '', 16), 0x11000000);
  assert.throws(() => regionAddress(DEFAULT_REGIONS, 'sram', String(520 * 1024 - 8), 16), /past the end of SRAM/);
  assert.throws(() => regionAddress(DEFAULT_REGIONS, 'sram', 'id(x)', 16), /offset is a number/);
  assert.throws(() => regionAddress({ ...DEFAULT_REGIONS, psram: [0, 0] }, 'psram', '0', 16), /no PSRAM/);
});
