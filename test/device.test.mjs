import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BadgeDevice } from '../simulator/device/badge.js';
import { bridgeSerial } from './bridge-port.mjs';

const PORTS = (process.env.BADGE_PORTS || '').split(',').filter(Boolean);
const skip = PORTS.length < 2 && 'set BADGE_PORTS=<repl>,<debug> to run hardware tests';

const APP = '/apps/ide_node_test';
const encode = (text) => new TextEncoder().encode(text);

let badge;

before(async () => {
  if (skip) return;
  badge = new BadgeDevice({ serial: bridgeSerial([...PORTS].reverse()) });
  await badge.connect();
});

after(async () => {
  if (skip) return;
  await badge.remove(APP).catch(() => {});
  await badge.disconnect();
});

test('identifies the REPL and debug ports', { skip }, () => {
  assert.equal(badge.ident.model, 'tufty2350');
  assert.ok(badge.connected);
  assert.equal(badge.replLink.port.path, PORTS[0]);
  assert.equal(badge.debugPort.path, PORTS[1]);
});

test('writes, reads and lists files', { skip }, async () => {
  const bytes = new Uint8Array(10000).map((_, i) => (i * 7) & 0xff);
  await badge.write('/ide_node_test.bin', bytes);
  assert.deepEqual(await badge.read('/ide_node_test.bin'), bytes);
  const listing = await badge.list('/');
  assert.ok(listing.some(([path, size]) => path === '/ide_node_test.bin' && size === bytes.length));
  await badge.remove('/ide_node_test.bin');
});

test('sync uploads only changed files', { skip }, async () => {
  const files = [
    { path: `${APP}/__init__.py`, bytes: encode('run(lambda: True)\n') },
    { path: `${APP}/data.txt`, bytes: encode('one') },
  ];
  assert.deepEqual(await badge.sync(files), files.map((f) => f.path));
  files[1].bytes = encode('two');
  assert.deepEqual(await badge.sync(files), [`${APP}/data.txt`]);
  assert.deepEqual(await badge.sync(files), []);
});

test('run streams a traceback with the app path', { skip }, async () => {
  await badge.write(`${APP}/__init__.py`, encode('def update():\n    return 1 / 0\n\nrun(update)\n'));
  let output = '';
  const result = await badge.run(APP, { onOutput: (text) => { output += text; } });
  assert.equal(result.stderr, '');
  assert.match(output, new RegExp(`File "${APP}/__init__.py", line 2, in update`));
  assert.match(output, /ZeroDivisionError/);
});

test('stop interrupts a running app', { skip }, async () => {
  await badge.write(`${APP}/__init__.py`, encode('def update():\n    pass\n\nrun(update)\n'));
  const running = badge.run(APP);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await badge.stop();
  const result = await running;
  assert.match(result.stderr, /KeyboardInterrupt/);
});

test('debug session stops at a breakpoint and inspects globals', { skip }, async () => {
  const source = 'count = 0\n\ndef update():\n    global count\n    count += 1\n    if count > 3:\n        return True\n\nrun(update)\n';
  await badge.write(`${APP}/__init__.py`, encode(source));
  const seen = [];
  const controller = {
    init: () => ({ breakpoints: { [`${APP}/__init__.py`]: [5] } }),
    attach(client) {
      client.addEventListener('stopped', async ({ detail }) => {
        seen.push(detail.stack[0].line);
        const scopes = await client.request({ cmd: 'scopes', frame: 0 }, 'scopes');
        seen.push(scopes.globals.find((v) => v.name === 'count').value);
        if (seen.length >= 4) await client.send({ cmd: 'setBreakpoints', file: `${APP}/__init__.py`, lines: [] });
        await client.send({ cmd: 'continue' });
      });
    },
  };
  const result = await badge.run(APP, { debug: controller });
  assert.equal(result.stderr, '');
  assert.deepEqual(seen, [5, '0', 5, '1']);
});

test('rejects badges without IDE firmware or with unsupported models', async () => {
  const { checkCompatible, IncompatibleBadgeError } = await import('../simulator/device/badge.js');
  assert.throws(() => checkCompatible(null), IncompatibleBadgeError);
  assert.throws(() => checkCompatible({ ident: 'badgeware-ide', protocol: 1, model: 'badger2350', board: 'Pimoroni Badger 2350' }), /Badger 2350 is not supported/);
  assert.throws(() => checkCompatible({ ident: 'badgeware-ide', protocol: 2, model: 'tufty2350' }), /protocol 2/);
  assert.doesNotThrow(() => checkCompatible({ ident: 'badgeware-ide', protocol: 1, model: 'tufty2350' }));
});
