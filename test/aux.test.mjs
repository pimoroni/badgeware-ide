import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AuxClient, supportsAux } from '../simulator/device/aux.js';
import { BadgeDevice, consoleFilter } from '../simulator/device/badge.js';
import { AuxTransport } from '../simulator/device/aux-transport.js';

const encoder = new TextEncoder();
const encode = (text) => encoder.encode(text);
const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';

class FakeFirmware {
  constructor(client, { files = {}, app = null } = {}) {
    this.client = client;
    this.files = new Map(Object.entries(files).map(([path, text]) => [path, encode(text)]));
    this.dirs = new Set(['/']);
    for (const path of this.files.keys()) this.addParents(path);
    this.handles = new Map();
    this.app = app;
    this.held = false;
    this.commands = [];
    this.onAppRun = null;
    client.link = { write: async (data) => this.receive(data), close: async () => {} };
  }

  addParents(path) {
    for (let dir = parentOf(path); !this.dirs.has(dir); dir = parentOf(dir)) this.dirs.add(dir);
  }

  state() {
    if (this.held) return 'held';
    return this.app ? 'running' : 'idle';
  }

  emit(message, payload = null) {
    this.client.receive(encode(JSON.stringify(message) + '\n'));
    if (payload) this.client.receive(payload);
  }

  emitState() {
    this.emit({ event: 'fs.state', state: this.state(), app: this.app });
  }

  checkWritable(path) {
    if (this.state() !== 'running') return;
    if (path === this.app || path.startsWith(this.app + '/') || this.app.startsWith(path + '/')) throw Object.assign(new Error('busy'), { errno: 'EBUSY' });
  }

  receive(data) {
    const bytes = typeof data === 'string' ? encode(data) : data;
    const newline = bytes.indexOf(10);
    const request = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline)));
    const payload = bytes.subarray(newline + 1, newline + 1 + (request.bytes ?? 0));
    this.commands.push(request.cmd);
    queueMicrotask(() => {
      try {
        const [reply, replyPayload] = this.handle(request, payload) ?? [{}];
        this.emit({ event: request.cmd, id: request.id, ...reply }, replyPayload);
      } catch (error) {
        this.emit({ event: 'error', id: request.id, errno: error.errno ?? 'EIO', message: error.message });
      }
    });
  }

  handle(request, payload) {
    const fail = (errno) => { throw Object.assign(new Error(errno), { errno }); };
    switch (request.cmd) {
      case 'fs.watch':
        return null;
      case 'fs.list': {
        if (!this.dirs.has(request.path)) fail('ENOENT');
        const prefix = request.path === '/' ? '/' : request.path + '/';
        const names = [...this.dirs, ...this.files.keys()]
          .filter((path) => path !== request.path && path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .sort();
        const page = names.slice(request.offset, request.offset + request.limit);
        const entries = page.map((path) => ({ name: path.slice(prefix.length), type: this.dirs.has(path) ? 'dir' : 'file', size: this.files.get(path)?.length ?? 0, mtime: 0 }));
        return [{ entries, more: request.offset + page.length < names.length }];
      }
      case 'fs.read': {
        const data = this.files.get(request.path) ?? fail('ENOENT');
        const chunk = data.subarray(request.offset, request.offset + request.length);
        return [{ eof: request.offset + chunk.length >= data.length, bytes: chunk.length }, chunk];
      }
      case 'fs.hash': {
        const data = this.files.get(request.path) ?? fail('ENOENT');
        return [{ sha256: createHash('sha256').update(data).digest('hex'), size: data.length }];
      }
      case 'fs.open': {
        this.checkWritable(request.path);
        if (!this.dirs.has(parentOf(request.path))) fail('ENOENT');
        const handle = this.handles.size + 1;
        this.handles.set(handle, { path: request.path, chunks: [] });
        return [{ handle }];
      }
      case 'fs.write':
        this.handles.get(request.handle).chunks.push(Uint8Array.from(payload));
        return [{ written: payload.length }];
      case 'fs.close': {
        const { path, chunks } = this.handles.get(request.handle);
        this.handles.delete(request.handle);
        this.files.set(path, Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
        return [{ size: this.files.get(path).length }];
      }
      case 'fs.mkdir':
        this.addParents(request.path + '/x');
        return null;
      case 'fs.lock':
        this.held = true;
        this.app = null;
        return [{ state: 'held' }];
      case 'fs.unlock':
        this.held = false;
        return [{ state: this.state() }];
      case 'app.run':
        this.held = false;
        queueMicrotask(() => this.onAppRun?.(request));
        return null;
      case 'app.stop':
        this.held = true;
        this.app = null;
        queueMicrotask(() => this.emitState());
        return [{ state: 'held' }];
      default:
        return fail('EINVAL');
    }
  }
}

function connectedDevice(firmware) {
  const device = new BadgeDevice({ serial: {} });
  device.replLink = { onData: null };
  device.transport = new AuxTransport({ device, repl: { link: device.replLink }, client: firmware.client });
  return device;
}

test('detects aux support from the ident features', () => {
  assert.equal(supportsAux({ features: ['repl', 'debug', 'littlefs', 'fs', 'app'] }), true);
  assert.equal(supportsAux({ features: ['repl', 'debug', 'littlefs'] }), false);
  assert.equal(supportsAux(null), false);
});

test('writes and reads files in chunks, creating parent directories', async () => {
  const client = new AuxClient({});
  const firmware = new FakeFirmware(client);
  const bytes = new Uint8Array(10000).map((_, i) => (i * 7) & 0xff);
  const progress = [];
  await client.write('/apps/new/data.bin', bytes, (sent) => progress.push(sent));
  assert.deepEqual(progress, [4096, 8192, 10000]);
  assert.deepEqual(firmware.files.get('/apps/new/data.bin'), bytes);
  assert.deepEqual(await client.read('/apps/new/data.bin'), bytes);
  assert.deepEqual(await client.read('/apps/new/empty.bin').catch((error) => error.errno), 'ENOENT');
});

test('walks directories across list pages', async () => {
  const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`/data/f${String(i).padStart(3, '0')}`, 'x']));
  const client = new AuxClient({});
  new FakeFirmware(client, { files: { ...files, '/apps/a/__init__.py': 'pass' } });
  const listing = await client.walk('/');
  assert.deepEqual(listing.slice(0, 3), [['/apps', -1], ['/apps/a', -1], ['/apps/a/__init__.py', 4]]);
  assert.equal(listing.filter(([path]) => path.startsWith('/data/')).length, 300);
});

test('hash is null for missing files and errors carry errno', async () => {
  const client = new AuxClient({});
  new FakeFirmware(client, { files: { '/a.txt': 'abc' } });
  assert.equal(await client.hash('/a.txt'), createHash('sha256').update('abc').digest('hex'));
  assert.equal(await client.hash('/missing.txt'), null);
  await assert.rejects(client.call('fs.nope'), (error) => error.errno === 'EINVAL');
});

test('sync uploads only changed files without locking', async () => {
  const client = new AuxClient({});
  const firmware = new FakeFirmware(client, { files: { '/apps/a/__init__.py': 'same' }, app: '/apps/menu' });
  const device = connectedDevice(firmware);
  const changed = await device.sync([
    { path: '/apps/a/__init__.py', bytes: encode('same') },
    { path: '/apps/a/data.txt', bytes: encode('new') },
  ]);
  assert.deepEqual(changed, ['/apps/a/data.txt']);
  assert.ok(!firmware.commands.includes('fs.lock'));
});

test('sync locks when a write hits the running app, and holds only when asked', async () => {
  const client = new AuxClient({});
  const firmware = new FakeFirmware(client, { files: { '/apps/a/__init__.py': 'old' }, app: '/apps/a' });
  const device = connectedDevice(firmware);
  await device.sync([{ path: '/apps/a/__init__.py', bytes: encode('new') }]);
  assert.deepEqual(firmware.commands.filter((cmd) => cmd.startsWith('fs.lock') || cmd.startsWith('fs.unlock')), ['fs.lock', 'fs.unlock']);
  firmware.app = '/apps/a';
  firmware.commands = [];
  await device.sync([{ path: '/apps/a/__init__.py', bytes: encode('newer') }], null, { hold: true });
  assert.ok(firmware.commands.includes('fs.lock'));
  assert.ok(!firmware.commands.includes('fs.unlock'));
  assert.equal(firmware.held, true);
});

test('run streams console output and finishes when the app exits', async () => {
  const client = new AuxClient({});
  const firmware = new FakeFirmware(client, { app: '/apps/menu' });
  const device = connectedDevice(firmware);
  firmware.onAppRun = ({ path }) => {
    firmware.app = null;
    firmware.emitState();
    device.replLink.onData(encode('MPY: soft reboot\r\n'));
    firmware.app = path;
    firmware.emitState();
    device.transport.console(encode('hello\r\nwor'));
    device.transport.console(encode('ld\r\nMPY: soft reboot\r\n'));
    firmware.app = null;
    firmware.emitState();
    firmware.app = '/apps/menu';
    firmware.emitState();
  };
  device.transport.attachConsole();
  const seen = [];
  const result = await device.run('/apps/a', { onOutput: (text) => seen.push(text) });
  assert.equal(result.stdout, 'hello\r\nworld\r\n');
  assert.equal(result.interrupted, false);
  assert.equal(device.running, false);
  assert.deepEqual(firmware.commands, ['app.run']);
});

test('stop ends a run with app.stop and fs.unlock', async () => {
  const client = new AuxClient({});
  const firmware = new FakeFirmware(client, { app: '/apps/menu' });
  const device = connectedDevice(firmware);
  firmware.onAppRun = ({ path }) => {
    firmware.app = path;
    firmware.emitState();
  };
  const running = device.run('/apps/a');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await device.stop();
  const result = await running;
  assert.equal(result.interrupted, true);
  assert.deepEqual(firmware.commands, ['app.run', 'app.stop', 'fs.unlock']);
});

test('a run can start straight after stop and idle', async () => {
  const client = new AuxClient({});
  const firmware = new FakeFirmware(client, { app: '/apps/menu' });
  const device = connectedDevice(firmware);
  firmware.onAppRun = ({ path }) => {
    firmware.app = path;
    firmware.emitState();
  };
  const first = device.run('/apps/a');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await device.stop();
  await device.idle();
  assert.equal(device.running, false);
  const second = device.run('/apps/b');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await device.stop();
  assert.equal((await first).interrupted, true);
  assert.equal((await second).interrupted, true);
});

test('debug runs share the aux link through a session', async () => {
  const client = new AuxClient({});
  const firmware = new FakeFirmware(client, { app: '/apps/menu' });
  const device = connectedDevice(firmware);
  const sent = [];
  const originalReceive = firmware.receive.bind(firmware);
  firmware.receive = (data) => {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    if (text.includes('"cmd":"init"')) {
      sent.push(JSON.parse(text));
      firmware.emit({ event: 'stopped', reason: 'breakpoint', stack: [] });
      firmware.app = null;
      firmware.emitState();
      return;
    }
    originalReceive(data);
  };
  firmware.onAppRun = ({ path, debug }) => {
    assert.equal(debug, true);
    firmware.app = path;
    firmware.emitState();
    firmware.emit({ event: 'ready' });
  };
  const events = [];
  const controller = {
    init: () => ({ breakpoints: { '/apps/a/__init__.py': [3] } }),
    attach(session) {
      session.addEventListener('stopped', () => events.push('stopped'));
      session.addEventListener('closed', () => events.push('closed'));
    },
  };
  await device.run('/apps/a', { debug: controller });
  assert.deepEqual(sent.map((message) => message.breakpoints), [{ '/apps/a/__init__.py': [3] }]);
  assert.deepEqual(events, ['stopped', 'closed']);
});

test('returning to the launcher unlocks and keeps the connection', async () => {
  const client = new AuxClient({});
  const firmware = new FakeFirmware(client);
  const device = connectedDevice(firmware);
  assert.equal(await device.returnToLauncher(), true);
  assert.equal(device.connected, true);
  assert.deepEqual(firmware.commands, ['fs.unlock']);
});

test('a disconnected device rejects commands and ignores lock', async () => {
  const device = new BadgeDevice({ serial: {} });
  await assert.rejects(device.read('/a.txt'), { name: 'LinkClosedError' });
  await assert.rejects(device.sync([]), { name: 'LinkClosedError' });
  await device.lock();
  await device.unlock();
  await device.stop();
  assert.equal(device.running, false);
});

test('console filter drops soft reboot lines across chunk boundaries', () => {
  const out = [];
  const filter = consoleFilter((text) => out.push(text));
  filter.push('MPY: soft re');
  filter.push('boot\r\nhi\r\n');
  filter.push('tail');
  filter.flush();
  assert.deepEqual(out, ['hi\r\n', 'tail']);
});
