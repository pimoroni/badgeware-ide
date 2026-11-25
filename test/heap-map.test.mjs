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
