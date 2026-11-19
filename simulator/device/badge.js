import { SerialLink, LinkClosedError } from './serial-link.js';
import { RawRepl } from './raw-repl.js';
import { AuxClient, supportsAux } from './aux.js';
import { ReplTransport } from './repl-transport.js';
import { AuxTransport } from './aux-transport.js';
import { BOARD_LIST } from '../boards.js';

export { BadgeBusyError } from './transport.js';
export { consoleFilter } from './aux-transport.js';

export const BADGE_FILTERS = BOARD_LIST
  .map((board) => ({ usbVendorId: 0x2e8a, usbProductId: board.usbProductId }))
  .sort((a, b) => a.usbProductId - b.usbProductId);

export const SUPPORTED_MODELS = Object.fromEntries(BOARD_LIST.map((board) => [board.model, board.label]));
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

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

const isBadgePort = (port) => {
  const { usbVendorId, usbProductId } = port.getInfo();
  return BADGE_FILTERS.some((filter) => filter.usbVendorId === usbVendorId && filter.usbProductId === usbProductId);
};

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
    this.debugPort = null;
    this.transport = null;
    this.ident = null;
    this.productId = null;
    this.onDisconnect = (event) => {
      if (event.target === this.replLink?.port || (this.transport?.holdsDebugPort && event.target === this.debugPort)) this.handleLost();
    };
  }

  get connected() {
    return !!this.transport;
  }

  get canDebug() {
    return !!this.debugPort;
  }

  get running() {
    return this.transport?.running ?? false;
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
    this.productId = ports[0].getInfo().usbProductId;
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
    const transport = this.createTransport(new RawRepl(replLink));
    try {
      await transport.open();
    } catch (error) {
      await transport.close();
      await replLink.close();
      this.debugPort = null;
      throw error;
    }
    this.replLink = replLink;
    this.transport = transport;
    this.serial.addEventListener?.('disconnect', this.onDisconnect);
    this.emit('connected', this.ident);
  }

  createTransport(repl) {
    if (supportsAux(this.ident)) return new AuxTransport({ device: this, repl, client: new AuxClient(this.debugPort) });
    return new ReplTransport({ device: this, repl, debugPort: this.debugPort });
  }

  async disconnect({ restart = true } = {}) {
    if (!this.connected) return;
    const transport = this.transport;
    try {
      if (this.running) await this.stop();
      await transport.idle();
      if (restart) await transport.resumeFirmware();
    } catch (_) {}
    await transport.close();
    await this.replLink.close();
    this.reset();
  }

  handleLost() {
    if (!this.connected) return;
    this.transport.close();
    this.replLink.close();
    this.reset();
  }

  reset() {
    this.serial.removeEventListener?.('disconnect', this.onDisconnect);
    this.transport?.detach();
    this.replLink = null;
    this.debugPort = null;
    this.transport = null;
    this.ident = null;
    this.emit('disconnected');
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  withTransport(fn) {
    if (!this.transport) return Promise.reject(new LinkClosedError());
    return fn(this.transport);
  }

  idle() {
    return this.transport?.idle() ?? Promise.resolve();
  }

  resumeFirmware() {
    return this.withTransport((transport) => transport.resumeFirmware());
  }

  info() {
    return this.withTransport((transport) => transport.info());
  }

  list(path = '/') {
    return this.withTransport((transport) => transport.list(path));
  }

  hashes(paths) {
    return this.withTransport((transport) => transport.hashes(paths));
  }

  remove(path) {
    return this.withTransport((transport) => transport.remove(path));
  }

  rename(source, destination) {
    return this.withTransport((transport) => transport.rename(source, destination));
  }

  makeDirectory(path) {
    return this.withTransport((transport) => transport.makeDirectory(path));
  }

  read(path) {
    return this.withTransport((transport) => transport.read(path));
  }

  write(path, bytes, onProgress = null) {
    return this.withTransport((transport) => transport.write(path, bytes, onProgress));
  }

  romFonts() {
    return this.withTransport((transport) => transport.romFonts());
  }

  romInfo() {
    return this.withTransport((transport) => transport.romInfo());
  }

  romInstall(path, bytes, onProgress = null) {
    return this.withTransport((transport) => transport.romInstall(path, bytes, onProgress));
  }

  romRemove(path) {
    return this.withTransport((transport) => transport.romRemove(path));
  }

  sync(files, onProgress = null, { hold = false } = {}) {
    return this.withTransport((transport) => transport.sync(files, onProgress, { hold }));
  }

  run(path, { debug = null, onOutput = null } = {}) {
    return this.withTransport((transport) => transport.run(path, { debug, onOutput }));
  }

  lock() {
    return this.transport?.lock() ?? Promise.resolve();
  }

  unlock() {
    return this.transport?.unlock() ?? Promise.resolve();
  }

  async returnToLauncher() {
    if (await this.withTransport((transport) => transport.returnToLauncher())) return true;
    await this.disconnect();
    return false;
  }

  async enterBootloader() {
    const command = '\r\x03\x03\r\x02import machine; machine.bootloader()\r';
    if (this.connected) {
      await this.stop();
      const link = this.replLink;
      const transport = this.transport;
      this.reset();
      try {
        await link.write(command);
      } catch (_) {}
      await link.close();
      await transport.close();
      return;
    }
    for (const port of await this.knownPorts()) {
      const link = new SerialLink(port);
      try {
        await link.open();
        await link.write(command);
      } catch (_) {}
      await link.close();
    }
  }

  async stop() {
    if (!this.running) return;
    await this.transport.stop();
  }
}
