import { contiguousRuns, SECTOR_SIZE } from './uf2.js';

export const BOOTSEL_FILTERS = [{ vendorId: 0x2e8a, productId: 0x000f }];

const PICOBOOT_MAGIC = 0x431fd10b;
const PC_EXCLUSIVE_ACCESS = 0x01;
const PC_FLASH_ERASE = 0x03;
const PC_READ = 0x84;
const PC_WRITE = 0x05;
const PC_EXIT_XIP = 0x06;
const PC_REBOOT2 = 0x0a;
const PICOBOOT_IF_RESET = 0x41;
const EXCLUSIVE = 1;
const WRITE_CHUNK = 32 * 1024;
const ERASE_CHUNK = 256 * 1024;
const TRANSFER_TIMEOUT_MS = 30000;

export class Picoboot {
  constructor(device) {
    this.device = device;
    this.token = 1;
  }

  async open() {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const iface = this.device.configuration.interfaces.find((candidate) => candidate.alternates[0].interfaceClass === 0xff);
    if (!iface) throw new Error('This device has no PICOBOOT interface');
    this.interfaceNumber = iface.interfaceNumber;
    await this.device.claimInterface(this.interfaceNumber);
    const endpoints = iface.alternates[0].endpoints;
    this.endpointIn = endpoints.find((endpoint) => endpoint.direction === 'in').endpointNumber;
    this.endpointOut = endpoints.find((endpoint) => endpoint.direction === 'out').endpointNumber;
    await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: PICOBOOT_IF_RESET, value: 0, index: this.interfaceNumber }, new Uint8Array(0));
  }

  async close() {
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch (_) {}
    try {
      await this.device.close();
    } catch (_) {}
  }

  async command(id, args = new Uint8Array(0), { transferLength = 0, data = null } = {}) {
    const packet = new Uint8Array(32);
    const view = new DataView(packet.buffer);
    view.setUint32(0, PICOBOOT_MAGIC, true);
    view.setUint32(4, this.token++, true);
    packet[8] = id;
    packet[9] = args.length;
    view.setUint32(12, transferLength, true);
    packet.set(args, 16);
    await this.expectOk(await this.device.transferOut(this.endpointOut, packet, TRANSFER_TIMEOUT_MS));
    let result = null;
    if (transferLength) {
      if (id & 0x80) {
        const received = await this.device.transferIn(this.endpointIn, transferLength, TRANSFER_TIMEOUT_MS);
        result = new Uint8Array(received.data.buffer, received.data.byteOffset, received.data.byteLength);
      } else {
        await this.expectOk(await this.device.transferOut(this.endpointOut, data, TRANSFER_TIMEOUT_MS));
      }
    }
    if (id & 0x80) await this.expectOk(await this.device.transferOut(this.endpointOut, new Uint8Array(0), TRANSFER_TIMEOUT_MS));
    else await this.expectOk(await this.device.transferIn(this.endpointIn, 1, TRANSFER_TIMEOUT_MS));
    return result;
  }

  async expectOk(transfer) {
    if (transfer.status !== 'ok') throw new Error(`USB transfer failed: ${transfer.status}`);
    return transfer;
  }

  static rangeArgs(address, size) {
    const args = new Uint8Array(8);
    const view = new DataView(args.buffer);
    view.setUint32(0, address, true);
    view.setUint32(4, size, true);
    return args;
  }

  exclusiveAccess() {
    return this.command(PC_EXCLUSIVE_ACCESS, Uint8Array.of(EXCLUSIVE));
  }

  exitXip() {
    return this.command(PC_EXIT_XIP);
  }

  erase(address, size) {
    return this.command(PC_FLASH_ERASE, Picoboot.rangeArgs(address, size));
  }

  write(address, data) {
    return this.command(PC_WRITE, Picoboot.rangeArgs(address, data.length), { transferLength: data.length, data });
  }

  read(address, size) {
    return this.command(PC_READ, Picoboot.rangeArgs(address, size), { transferLength: size });
  }

  async reboot(delayMs = 500) {
    const args = new Uint8Array(16);
    new DataView(args.buffer).setUint32(4, delayMs, true);
    try {
      await this.command(PC_REBOOT2, args);
    } catch (_) {}
  }

  async changedSectors(sectors, onProgress) {
    const changed = new Map();
    const total = sectors.size * SECTOR_SIZE;
    let checked = 0;
    for (const run of contiguousRuns(sectors)) {
      for (let offset = 0; offset < run.length; offset += WRITE_CHUNK) {
        const length = Math.min(WRITE_CHUNK, run.length - offset);
        const current = await this.read(run.address + offset, length);
        for (let sector = 0; sector < length; sector += SECTOR_SIZE) {
          const address = run.address + offset + sector;
          const wanted = sectors.get(address);
          const existing = current.subarray(sector, sector + SECTOR_SIZE);
          if (wanted.some((byte, i) => byte !== existing[i])) changed.set(address, wanted);
        }
        checked += length;
        onProgress({ phase: 'check', done: checked, total });
      }
    }
    return changed;
  }

  async flash(sectors, onProgress = () => {}) {
    await this.exclusiveAccess();
    await this.exitXip();
    const changed = await this.changedSectors(sectors, onProgress);
    const total = changed.size * SECTOR_SIZE;
    let done = 0;
    for (const run of contiguousRuns(changed)) {
      for (let offset = 0; offset < run.length; offset += ERASE_CHUNK) {
        await this.erase(run.address + offset, Math.min(ERASE_CHUNK, run.length - offset));
      }
      for (let offset = 0; offset < run.length; offset += WRITE_CHUNK) {
        const length = Math.min(WRITE_CHUNK, run.length - offset);
        const chunk = new Uint8Array(length);
        for (let sector = 0; sector < length; sector += SECTOR_SIZE) {
          chunk.set(changed.get(run.address + offset + sector), sector);
        }
        await this.write(run.address + offset, chunk);
        done += length;
        onProgress({ phase: 'write', done, total });
      }
    }
    return { checked: sectors.size, written: changed.size };
  }
}
