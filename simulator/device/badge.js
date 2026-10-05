import { SerialLink, LinkClosedError } from './serial-link.js';
import { RawRepl } from './raw-repl.js';
import { DebugClient } from './debug.js';

export const BADGE_FILTERS = [
  { usbVendorId: 0x2e8a, usbProductId: 0x1100 },
  { usbVendorId: 0x2e8a, usbProductId: 0x1101 },
  { usbVendorId: 0x2e8a, usbProductId: 0x1102 },
];

export const SUPPORTED_MODELS = { tufty2350: 'Tufty 2350' };
export const PROTOCOL_VERSION = 1;

export class MissingReplError extends Error {
  constructor(ident) {
    super('Could not find the badge REPL port.');
    this.name = 'MissingReplError';
    this.ident = ident;
  }
}

export class IncompatibleBadgeError extends Error {
  constructor(message, ident = null) {
    super(message);
    this.name = 'IncompatibleBadgeError';
    this.ident = ident;
  }
}

const ACK = 0x06;
const CHUNK_SIZE = 4096;

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

const py = (value) => JSON.stringify(value);

const isBadgePort = (port) => {
  const { usbVendorId, usbProductId } = port.getInfo();
  return BADGE_FILTERS.some((filter) => filter.usbVendorId === usbVendorId && filter.usbProductId === usbProductId);
};

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function probe(link) {
  link.discard();
  await link.write('\x03');
  try {
    const reply = await link.readUntil('\n', { timeout: 400 });
    const text = new TextDecoder().decode(reply).trim();
    if (text.startsWith('{')) {
      const ident = JSON.parse(text);
      if (ident.ident === 'badgeware-ide') return { kind: 'debug', ident };
    }
    return { kind: 'repl' };
  } catch (_) {
    return { kind: link.available ? 'repl' : 'silent' };
  }
}

export function checkCompatible(ident) {
  if (!ident) {
    throw new IncompatibleBadgeError('This badge is not running Badgeware IDE firmware. Update its firmware, or use the simulator.');
  }
  if (!SUPPORTED_MODELS[ident.model]) {
    throw new IncompatibleBadgeError(`${ident.board || 'This badge'} is not supported by the IDE yet.`, ident);
  }
  if (ident.protocol !== PROTOCOL_VERSION) {
    throw new IncompatibleBadgeError(`This badge's firmware speaks IDE protocol ${ident.protocol}, the IDE needs ${PROTOCOL_VERSION}. Update the firmware.`, ident);
  }
}

export class BadgeDevice extends EventTarget {
  constructor({ serial = globalThis.navigator?.serial } = {}) {
    super();
    this.serial = serial;
    this.replLink = null;
    this.repl = null;
    this.debugPort = null;
    this.ident = null;
    this.queue = Promise.resolve();
    this.running = false;
    this.onDisconnect = (event) => {
      if (event.target === this.replLink?.port) this.handleLost();
    };
  }

  get connected() {
    return !!this.repl;
  }

  get canDebug() {
    return !!this.debugPort;
  }

  async knownPorts() {
    return (await this.serial.getPorts()).filter(isBadgePort);
  }

  async requestPort() {
    await this.serial.requestPort({ filters: BADGE_FILTERS });
  }

  connect() {
    if (this.connected) return Promise.resolve();
    this.connecting ??= this.openPorts().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async openPorts() {
    const ports = await this.knownPorts();
    if (!ports.length) throw new Error('No paired badge found.');
    const candidates = [];
    for (const port of ports) {
      const link = new SerialLink(port);
      try {
        await link.open();
      } catch (_) {
        continue;
      }
      const result = await probe(link);
      if (result.kind === 'debug' && !this.debugPort) {
        this.debugPort = port;
        this.ident = result.ident;
        await link.close();
      } else {
        candidates.push({ link, replied: result.kind === 'repl' });
      }
    }
    candidates.sort((a, b) => b.replied - a.replied);
    const replLink = candidates.shift()?.link ?? null;
    await Promise.all(candidates.map(({ link }) => link.close()));
    try {
      if (!replLink) throw new MissingReplError(this.ident);
      checkCompatible(this.ident);
    } catch (error) {
      await replLink?.close();
      this.debugPort = null;
      throw error;
    }
    const repl = new RawRepl(replLink);
    try {
      await repl.enter({ softReset: true });
    } catch (error) {
      await replLink.close();
      this.debugPort = null;
      throw error;
    }
    this.replLink = replLink;
    this.repl = repl;
    this.serial.addEventListener?.('disconnect', this.onDisconnect);
    this.emit('connected', this.ident);
  }

  async disconnect({ restart = true } = {}) {
    if (!this.connected) return;
    try {
      if (this.running) await this.stop();
      await this.queue.catch(() => {});
      if (restart) await this.repl.restartFirmware();
    } catch (_) {}
    await this.replLink.close();
    this.reset();
  }

  handleLost() {
    if (!this.connected) return;
    this.replLink.close();
    this.reset();
  }

  reset() {
    this.serial.removeEventListener?.('disconnect', this.onDisconnect);
    this.replLink = null;
    this.repl = null;
    this.debugPort = null;
    this.ident = null;
    this.running = false;
    this.emit('disconnected');
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  task(fn) {
    const result = this.queue.then(() => {
      if (!this.connected) throw new LinkClosedError();
      return fn();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  info() {
    return this.task(() => this.repl.execJson('import ide; ide.info()'));
  }

  list(path = '/') {
    return this.task(() => this.repl.execJson(`import ide; ide.ls(${py(path)})`));
  }

  hashes(paths) {
    return this.task(() => this.repl.execJson(`import ide; ide.hashes(${py(paths)})`, { timeout: 30000 }));
  }

  remove(path) {
    return this.task(() => this.repl.exec(`import ide; ide.rm(${py(path)})`));
  }

  rename(source, destination) {
    return this.task(() => this.repl.exec(`import ide; ide.rename(${py(source)}, ${py(destination)})`));
  }

  makeDirectory(path) {
    return this.task(() => this.repl.exec(`import ide; ide.mkdir(${py(path)})`));
  }

  read(path) {
    return this.task(async () => {
      const text = await this.repl.exec(`import ide; ide.get(${py(path)})`, { timeout: 30000 });
      const binary = atob(text.replace(/\s+/g, ''));
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    });
  }

  write(path, bytes, onProgress = null) {
    return this.task(() => this.writeNow(path, bytes, onProgress));
  }

  romFonts() {
    return this.task(async () => (await this.repl.execJson('import ide; ide.ls("/rom/fonts")')).map(([path]) => path.split('/').pop()));
  }

  romInfo() {
    return this.task(() => this.repl.execJson('import ide; ide.rom_info()'));
  }

  romInstall(path, bytes, onProgress = null) {
    return this.task(() => this.writeNow(path, bytes, onProgress, { command: 'rom_put', timeout: 120000 }));
  }

  romRemove(path) {
    return this.task(() => this.repl.execJson(`import ide; ide.rom_remove(${py(path)})`, { timeout: 120000 }));
  }

  async writeNow(path, bytes, onProgress, { command = 'put', timeout = 10000 } = {}) {
    const link = this.replLink;
    await this.repl.start(`import ide; ide.${command}(${py(path)}, ${bytes.length})`);
    await this.expectAck(link);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      await link.write(bytes.subarray(offset, offset + CHUNK_SIZE));
      await this.expectAck(link);
      onProgress?.(Math.min(offset + CHUNK_SIZE, bytes.length), bytes.length);
    }
    const { stdout, stderr } = await this.repl.follow({ timeout });
    if (stderr) throw new Error(stderr.trim().split('\n').pop());
    return stdout;
  }

  async expectAck(link) {
    const [byte] = await link.readExactly(1, { timeout: 5000 });
    if (byte !== ACK) throw new Error(`Unexpected reply while writing a file: 0x${byte.toString(16)}`);
  }

  sync(files, onProgress = null) {
    return this.task(async () => {
      const paths = files.map((file) => file.path);
      const remote = paths.length ? await this.repl.execJson(`import ide; ide.hashes(${py(paths)})`, { timeout: 30000 }) : {};
      const changed = [];
      for (const file of files) {
        if (remote[file.path] !== await sha256Hex(file.bytes)) changed.push(file);
      }
      const total = changed.reduce((sum, file) => sum + file.bytes.length, 0);
      let done = 0;
      for (const file of changed) {
        await this.writeNow(file.path, file.bytes, (sent) => onProgress?.(done + sent, total, file.path));
        done += file.bytes.length;
      }
      return changed.map((file) => file.path);
    });
  }

  run(path, { debug = null, onOutput = null } = {}) {
    return this.task(async () => {
      let client = null;
      if (debug) {
        if (!this.debugPort) throw new Error('The debug port is not available.');
        client = new DebugClient(this.debugPort);
        await client.open();
        debug.attach?.(client);
      }
      this.running = true;
      this.emit('running', { path, debug: !!client });
      try {
        await this.repl.start(`import ide; ide.execute(${py(path)}, debug=${client ? 'True' : 'False'})`);
        if (client) {
          await client.waitFor('ready', 5000);
          client.send({ cmd: 'init', ...debug.init() });
        }
        return await this.repl.follow({ timeout: Infinity, onStdout: onOutput });
      } finally {
        this.running = false;
        if (client) await client.close();
        this.emit('stopped', { path });
      }
    });
  }

  async stop() {
    if (this.running) await this.replLink.write('\x03');
  }
}
