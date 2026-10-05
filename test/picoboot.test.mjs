import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseUf2 } from '../simulator/device/uf2.js';
import { Picoboot, BOOTSEL_FILTERS } from '../simulator/device/picoboot.js';

const FIRMWARE = process.env.BADGE_FLASH;
const PORTS = (process.env.BADGE_PORTS || '').split(',').filter(Boolean);
const PYTHON = process.env.BADGE_PYTHON || 'python3';
const skip = !(FIRMWARE && PORTS.length) && 'set BADGE_FLASH=<firmware.uf2> and BADGE_PORTS to flash a badge';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function python(code) {
  return execFileSync(PYTHON, ['-c', code], { encoding: 'utf8', timeout: 30000 });
}

test('flashes a badge over PICOBOOT', { skip, timeout: 300000 }, async () => {
  const { WebUSB } = await import('usb');
  const usb = new WebUSB({ allowAllDevices: true });
  const { sectors } = parseUf2(new Uint8Array(readFileSync(FIRMWARE)));

  const findBootsel = async () => (await usb.getDevices()).find((d) => BOOTSEL_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId)) ?? null;
  if (!(await findBootsel())) {
    python(`import serial, time\ns = serial.Serial(${JSON.stringify(PORTS[0])}, 115200)\ns.dtr = True\ns.write(b"\\r\\x03\\x03\\r\\x02import machine; machine.bootloader()\\r")\ntime.sleep(0.3)`);
  }
  let device = null;
  for (let attempt = 0; attempt < 50 && !device; attempt++) {
    await sleep(200);
    device = await findBootsel();
  }
  assert.ok(device, 'badge did not enter BOOTSEL');

  const picoboot = new Picoboot(device);
  await picoboot.open();
  const started = Date.now();
  const result = await picoboot.flash(sectors);
  const seconds = (Date.now() - started) / 1000;
  console.log(`checked ${result.checked} sectors, wrote ${result.written}`);
  const addresses = [...sectors.keys()];
  for (const address of [addresses[0], addresses[Math.floor(addresses.length / 2)], addresses.at(-1)]) {
    assert.deepEqual(await picoboot.read(address, 4096), sectors.get(address), `sector 0x${address.toString(16)}`);
  }
  console.log(`flashed ${sectors.size * 4} KB in ${seconds.toFixed(1)}s`);
  await picoboot.reboot();
  await picoboot.close();

  let alive = false;
  for (let attempt = 0; attempt < 30 && !alive; attempt++) {
    await sleep(500);
    try {
      alive = python(`import serial, time\ns = serial.Serial(${JSON.stringify(PORTS[1] ?? PORTS[0])}, 115200, timeout=1)\ns.dtr = True\ntime.sleep(0.2)\ns.reset_input_buffer()\ns.write(b"\\x03")\ntime.sleep(0.5)\nprint(s.read_all().decode(errors="replace"))`).includes('"ident"');
    } catch (_) {}
  }
  assert.ok(alive, 'badge did not come back with the IDE firmware');
});
