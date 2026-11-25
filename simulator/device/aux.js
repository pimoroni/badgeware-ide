import { DebugClient } from './debug.js';
import { concat } from './serial-link.js';

export const AUX_FEATURES = ['fs', 'app'];
export const AUX_CHUNK = 4096;
const REPLY_TIMEOUT_MS = 10000;
const HASH_TIMEOUT_MS = 30000;
export const RESET_TIMEOUT_MS = 20000;

export const supportsAux = (ident) => AUX_FEATURES.every((feature) => ident?.features?.includes(feature));

const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

export class AuxClient extends DebugClient {
  call(cmd, fields = {}, { payload = null, timeout = REPLY_TIMEOUT_MS } = {}) {
    return this.request({ cmd, ...fields }, cmd, timeout, payload);
  }

  info() {
    return this.call('fs.info');
  }

  watch(enable) {
    return this.call('fs.watch', { enable });
  }

  async listDir(path) {
    const entries = [];
    for (let offset = 0; ;) {
      const reply = await this.call('fs.list', { path, offset, limit: 256 });
      entries.push(...reply.entries);
      offset += reply.entries.length;
      if (!reply.more) return entries;
    }
  }

  async walk(path = '/') {
    const out = [];
    for (const entry of await this.listDir(path)) {
      const full = join(path, entry.name);
      if (entry.type === 'dir') {
        out.push([full, -1]);
        out.push(...await this.walk(full));
      } else {
        out.push([full, entry.size]);
      }
    }
    return out;
  }

  async read(path) {
    const chunks = [];
    let offset = 0;
    for (;;) {
      const reply = await this.call('fs.read', { path, offset, length: AUX_CHUNK });
      const data = reply.payload ?? new Uint8Array(0);
      chunks.push(data);
      offset += data.length;
      if (reply.eof || !data.length) return concat(chunks);
    }
  }

  async openHandle(path, size) {
    try {
      return (await this.call('fs.open', { path, size })).handle;
    } catch (error) {
      if (error.errno !== 'ENOENT') throw error;
      await this.mkdir(parentOf(path));
      return (await this.call('fs.open', { path, size })).handle;
    }
  }

  async write(path, bytes, onProgress = null) {
    const handle = await this.openHandle(path, bytes.length);
    try {
      for (let offset = 0; offset < bytes.length; offset += AUX_CHUNK) {
        await this.call('fs.write', { handle, offset }, { payload: bytes.subarray(offset, offset + AUX_CHUNK) });
        onProgress?.(Math.min(offset + AUX_CHUNK, bytes.length), bytes.length);
      }
    } catch (error) {
      await this.call('fs.abort', { handle }).catch(() => {});
      throw error;
    }
    await this.call('fs.close', { handle });
  }

  async hash(path) {
    try {
      return (await this.call('fs.hash', { path }, { timeout: HASH_TIMEOUT_MS })).sha256;
    } catch (error) {
      if (error.errno === 'ENOENT') return null;
      throw error;
    }
  }

  remove(path) {
    return this.call('fs.remove', { path, recursive: true });
  }

  rename(from, to) {
    return this.call('fs.rename', { from, to });
  }

  mkdir(path) {
    return this.call('fs.mkdir', { path, parents: true });
  }

  lock() {
    return this.call('fs.lock', {}, { timeout: RESET_TIMEOUT_MS });
  }

  unlock(resume = false) {
    return this.call('fs.unlock', { resume });
  }

  runApp(path, debug) {
    return this.call('app.run', { path, debug });
  }

  stopApp() {
    return this.call('app.stop', {}, { timeout: RESET_TIMEOUT_MS });
  }

  // Handled in C, so it works whatever the badge's Python is doing. The badge
  // drops off USB straight after replying, so a lost reply is not an error.
  bootloader() {
    return this.call('app.bootloader', {}, { timeout: 2000 }).catch(() => null);
  }
}
