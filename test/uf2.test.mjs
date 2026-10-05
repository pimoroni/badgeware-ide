import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUf2, contiguousRuns, UF2_FAMILY_RP2350_ARM_S } from '../simulator/device/uf2.js';

function block({ address, data, family = UF2_FAMILY_RP2350_ARM_S, flags = 0x2000 }) {
  const out = new Uint8Array(512);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x0a324655, true);
  view.setUint32(4, 0x9e5d5157, true);
  view.setUint32(8, flags, true);
  view.setUint32(12, address, true);
  view.setUint32(16, data.length, true);
  view.setUint32(28, family, true);
  out.set(data, 32);
  view.setUint32(508, 0x0ab16f30, true);
  return out;
}

function uf2(blocks) {
  const out = new Uint8Array(blocks.length * 512);
  blocks.forEach((b, i) => out.set(b, i * 512));
  return out;
}

test('assembles sectors and fills gaps with 0xff', () => {
  const { sectors, bytes } = parseUf2(uf2([
    block({ address: 0x10000000, data: new Uint8Array(256).fill(1) }),
    block({ address: 0x10000100, data: new Uint8Array(256).fill(2) }),
    block({ address: 0x10002000, data: new Uint8Array(256).fill(3) }),
  ]));
  assert.equal(bytes, 768);
  assert.deepEqual([...sectors.keys()], [0x10000000, 0x10002000]);
  const first = sectors.get(0x10000000);
  assert.equal(first[0], 1);
  assert.equal(first[256], 2);
  assert.equal(first[512], 0xff);
});

test('skips the RP2350-E10 absolute block and non-flash blocks', () => {
  const { sectors } = parseUf2(uf2([
    block({ address: 0x10000000, data: new Uint8Array(256) }),
    block({ address: 0x10ffff00, data: new Uint8Array(256), family: 0xe48bff57, flags: 0xa000 }),
    block({ address: 0x20000000, data: new Uint8Array(256), flags: 0x2001 }),
  ]));
  assert.deepEqual([...sectors.keys()], [0x10000000]);
});

test('groups sectors into contiguous runs', () => {
  const { sectors } = parseUf2(uf2([0, 0x1000, 0x2000, 0x8000, 0x9000].map((offset) => block({ address: 0x10000000 + offset, data: new Uint8Array(256) }))));
  assert.deepEqual(contiguousRuns(sectors), [{ address: 0x10000000, length: 0x3000 }, { address: 0x10008000, length: 0x2000 }]);
});

test('rejects files that are not UF2', () => {
  assert.throws(() => parseUf2(new Uint8Array(512)), /Not a UF2/);
  assert.throws(() => parseUf2(new Uint8Array(100)), /Not a UF2/);
});
