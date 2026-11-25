import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Picoboot } from '../simulator/device/picoboot.js';
import { SECTOR_SIZE } from '../simulator/device/uf2.js';

const BASE = 0x10000000;

// Flash held in memory, standing in for the badge behind PICOBOOT.
class FakePicoboot extends Picoboot {
  constructor({ dropWriteAt = null, failReadAt = null } = {}) {
    super(null);
    this.memory = new Uint8Array(16 * SECTOR_SIZE).fill(0xff);
    this.dropWriteAt = dropWriteAt;
    this.failReadAt = failReadAt;
  }

  async exclusiveAccess() {}
  async exitXip() {}

  async erase(address, size) {
    this.memory.fill(0xff, address - BASE, address - BASE + size);
  }

  async write(address, data) {
    if (address !== this.dropWriteAt) this.memory.set(data, address - BASE);
  }

  async read(address, size) {
    if (address === this.failReadAt) throw new Error('USB transfer failed: stall');
    return this.memory.slice(address - BASE, address - BASE + size);
  }
}

const sectorsOf = (count) => new Map(Array.from({ length: count }, (_, i) => [BASE + i * SECTOR_SIZE, new Uint8Array(SECTOR_SIZE).fill(i + 1)]));

test('flashing reads back what it wrote', async () => {
  const picoboot = new FakePicoboot();
  const phases = new Set();
  const result = await picoboot.flash(sectorsOf(4), ({ phase }) => phases.add(phase));
  assert.deepEqual(result, { checked: 4, written: 4 });
  assert.deepEqual([...phases], ['check', 'write', 'verify']);
  assert.equal(picoboot.memory[3 * SECTOR_SIZE], 4);
});

test('a write the flash did not take is reported with its address', async () => {
  const picoboot = new FakePicoboot({ dropWriteAt: BASE });
  await assert.rejects(picoboot.flash(sectorsOf(2)), /did not verify at 0x10000000/);
});

test('a failed transfer says what was happening and where', async () => {
  const picoboot = new FakePicoboot({ failReadAt: BASE });
  picoboot.changedSectors = async (sectors) => sectors;
  await assert.rejects(picoboot.flash(sectorsOf(1)), /stall while verifying flash at 0x10000000/);
});
