import { LinkClosedError } from './serial-link.js';

const ACK = 0x06;
const CHUNK_SIZE = 4096;

export const py = (value) => JSON.stringify(value);

export class BadgeBusyError extends Error {
  constructor() {
    super('Your badge is busy running an app. Stop it first.');
    this.name = 'BadgeBusyError';
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function changedFiles(files, remoteHashes) {
  const changed = [];
  for (const file of files) {
    if (remoteHashes[file.path] !== await sha256Hex(file.bytes)) changed.push(file);
  }
  return changed;
}

export class Transport {
  constructor({ device, repl }) {
    this.device = device;
    this.repl = repl;
    this.queue = Promise.resolve();
    this.running = false;
    this.closed = false;
  }

  get holdsDebugPort() {
    return false;
  }

  emit(type, detail) {
    this.device.emit(type, detail);
  }

  enqueue(fn) {
    const result = this.queue.then(() => {
      if (this.closed) throw new LinkClosedError();
      return fn();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  idle() {
    return this.queue;
  }

  detach() {
    this.closed = true;
  }

  romFonts() {
    return this.replTask(async () => (await this.repl.execJson('import ide; ide.ls("/rom/fonts")')).map(([path]) => path.split('/').pop()));
  }

  romInfo() {
    return this.replTask(() => this.repl.execJson('import ide; ide.rom_info()'));
  }

  romInstall(path, bytes, onProgress = null) {
    return this.replTask(() => this.replWrite(path, bytes, onProgress, { command: 'rom_put', timeout: 120000 }));
  }

  romRemove(path) {
    return this.replTask(() => this.repl.execJson(`import ide; ide.rom_remove(${py(path)})`, { timeout: 120000 }));
  }

  async replRead(path) {
    const text = await this.repl.exec(`import ide; ide.get(${py(path)})`, { timeout: 30000 });
    const binary = atob(text.replace(/\s+/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  async replWrite(path, bytes, onProgress, { command = 'put', timeout = 10000 } = {}) {
    const link = this.repl.link;
    await this.repl.start(`import ide; ide.${command}(${py(path)}, ${bytes.length})`);
    await expectAck(link);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      await link.write(bytes.subarray(offset, offset + CHUNK_SIZE));
      await expectAck(link);
      onProgress?.(Math.min(offset + CHUNK_SIZE, bytes.length), bytes.length);
    }
    const { stdout, stderr } = await this.repl.follow({ timeout });
    if (stderr) throw new Error(stderr.trim().split('\n').pop());
    return stdout;
  }
}

async function expectAck(link) {
  const [byte] = await link.readExactly(1, { timeout: 5000 });
  if (byte !== ACK) throw new Error(`Unexpected reply while writing a file: 0x${byte.toString(16)}`);
}
