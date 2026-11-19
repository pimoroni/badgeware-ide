import { LinkClosedError } from './serial-link.js';
import { DebugSession } from './debug.js';
import { RESET_TIMEOUT_MS } from './aux.js';
import { BadgeBusyError, Transport, changedFiles } from './transport.js';

const CONSOLE_SETTLE_MS = 150;
const SOFT_REBOOT_LINE = /^(MPY: )?soft reboot$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRomPath = (path) => path === '/rom' || path.startsWith('/rom/');

export function consoleFilter(emit) {
  let pending = '';
  return {
    push(text) {
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (!SOFT_REBOOT_LINE.test(line.trim())) emit(line);
      }
    },
    flush() {
      if (pending && !SOFT_REBOOT_LINE.test(pending.trim())) emit(pending);
      pending = '';
    },
  };
}

async function remoteHashes(client, paths) {
  const hashes = await Promise.all(paths.map((path) => client.hash(path)));
  return Object.fromEntries(paths.map((path, index) => [path, hashes[index]]));
}

async function writeFiles(client, files, onProgress, { hold = false } = {}) {
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  let done = 0;
  let locked = false;
  for (const file of files) {
    const progress = (sent) => onProgress?.(done + sent, total, file.path);
    try {
      await client.write(file.path, file.bytes, progress);
    } catch (error) {
      if (error.errno !== 'EBUSY' || locked) throw error;
      await client.lock();
      locked = true;
      await client.write(file.path, file.bytes, progress);
    }
    done += file.bytes.length;
  }
  if (locked && !hold) await client.unlock();
}

export class AuxTransport extends Transport {
  constructor({ device, repl, client }) {
    super({ device, repl });
    this.client = client;
    this.console = null;
    this.interrupted = false;
    this.runEnded = Promise.resolve();
    client.addEventListener('fs.changed', () => this.emit('fs-changed'));
    client.addEventListener('fs.state', ({ detail }) => this.emit('app-state', detail));
  }

  get holdsDebugPort() {
    return true;
  }

  async idle() {
    await Promise.all([super.idle(), this.runEnded]);
  }

  async open() {
    await this.client.open();
    await this.client.watch(true);
    this.attachConsole();
    await this.repl.restartFirmware();
  }

  attachConsole() {
    this.repl.link.onData = (bytes) => this.console?.(bytes);
  }

  close() {
    this.detach();
    return this.client.close().catch(() => {});
  }

  detach() {
    super.detach();
    this.console = null;
  }

  async resumeFirmware() {}

  task(fn) {
    return this.enqueue(() => fn(this.client));
  }

  replTask(fn) {
    if (this.running) return Promise.reject(new BadgeBusyError());
    return this.task(async () => {
      const link = this.repl.link;
      link.onData = null;
      link.discard();
      try {
        await this.repl.enter({ softReset: true });
        return await fn();
      } finally {
        await this.repl.restartFirmware().catch(() => {});
        this.attachConsole();
      }
    });
  }

  info() {
    return this.task((client) => client.info());
  }

  list(path) {
    return this.task((client) => client.walk(path));
  }

  hashes(paths) {
    return this.task((client) => remoteHashes(client, paths));
  }

  remove(path) {
    return this.task((client) => client.remove(path));
  }

  rename(source, destination) {
    return this.task((client) => client.rename(source, destination));
  }

  makeDirectory(path) {
    return this.task((client) => client.mkdir(path));
  }

  read(path) {
    if (isRomPath(path)) return this.replTask(() => this.replRead(path));
    return this.task((client) => client.read(path));
  }

  write(path, bytes, onProgress) {
    return this.task((client) => writeFiles(client, [{ path, bytes }], (sent, total) => onProgress?.(sent, total)));
  }

  sync(files, onProgress, { hold = false } = {}) {
    return this.task(async (client) => {
      const remote = await remoteHashes(client, files.map((file) => file.path));
      const changed = await changedFiles(files, remote);
      await writeFiles(client, changed, onProgress, { hold });
      return changed.map((file) => file.path);
    });
  }

  waitForAppEnd(path) {
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
      let started = false;
      const onState = ({ detail }) => {
        if (detail.state === 'running' && detail.app === path) {
          started = true;
        } else if (started || (this.interrupted && detail.state !== 'running')) {
          cancel();
          resolve();
        }
      };
      const onLost = () => {
        cancel();
        reject(new LinkClosedError());
      };
      this.device.addEventListener('app-state', onState);
      this.device.addEventListener('disconnected', onLost);
      cancel = () => {
        this.device.removeEventListener('app-state', onState);
        this.device.removeEventListener('disconnected', onLost);
      };
    });
    return { promise, cancel };
  }

  async run(path, { debug = null, onOutput = null } = {}) {
    if (this.running) throw new BadgeBusyError();
    let finishRun;
    this.runEnded = new Promise((resolve) => { finishRun = resolve; });
    const session = debug ? new DebugSession(this.client) : null;
    if (session) debug.attach?.(session);
    this.running = true;
    this.interrupted = false;
    this.emit('running', { path, debug: !!session });
    const decoder = new TextDecoder();
    let stdout = '';
    const output = consoleFilter((text) => {
      stdout += text;
      onOutput?.(text);
    });
    this.console = (bytes) => output.push(decoder.decode(bytes, { stream: true }));
    const ended = this.waitForAppEnd(path);
    try {
      const ready = session ? this.client.waitFor('ready', RESET_TIMEOUT_MS) : null;
      ready?.catch(() => {});
      await this.task((client) => client.runApp(path, !!session));
      if (session) {
        await ready;
        await this.client.send({ cmd: 'init', ...debug.init() });
      }
      await ended.promise;
      await sleep(CONSOLE_SETTLE_MS);
      output.flush();
      return { stdout, stderr: '', interrupted: this.interrupted };
    } finally {
      ended.cancel();
      this.console = null;
      this.running = false;
      session?.close();
      this.emit('stopped', { path });
      finishRun();
    }
  }

  async stop() {
    this.interrupted = true;
    await this.task(async (client) => {
      await client.stopApp();
      await client.unlock();
    });
  }

  lock() {
    return this.task((client) => client.lock());
  }

  unlock() {
    return this.task((client) => client.unlock());
  }

  async returnToLauncher() {
    if (this.running) await this.stop();
    else await this.task((client) => client.unlock());
    return true;
  }
}
