import { DebugClient } from './debug.js';
import { BadgeBusyError, Transport, changedFiles, py } from './transport.js';

export class ReplTransport extends Transport {
  constructor({ device, repl, debugPort = null }) {
    super({ device, repl });
    this.debugPort = debugPort;
  }

  open() {
    return this.repl.enter({ softReset: true });
  }

  async close() {
    this.detach();
  }

  resumeFirmware() {
    return this.repl.restartFirmware();
  }

  replTask(fn) {
    if (this.running) return Promise.reject(new BadgeBusyError());
    return this.enqueue(fn);
  }

  info() {
    return this.replTask(() => this.repl.execJson('import ide; ide.info()'));
  }

  list(path) {
    return this.replTask(() => this.repl.execJson(`import ide; ide.ls(${py(path)})`));
  }

  hashes(paths) {
    return this.replTask(() => this.repl.execJson(`import ide; ide.hashes(${py(paths)})`, { timeout: 30000 }));
  }

  remove(path) {
    return this.replTask(() => this.repl.exec(`import ide; ide.rm(${py(path)})`));
  }

  rename(source, destination) {
    return this.replTask(() => this.repl.exec(`import ide; ide.rename(${py(source)}, ${py(destination)})`));
  }

  makeDirectory(path) {
    return this.replTask(() => this.repl.exec(`import ide; ide.mkdir(${py(path)})`));
  }

  read(path) {
    return this.replTask(() => this.replRead(path));
  }

  write(path, bytes, onProgress) {
    return this.replTask(() => this.replWrite(path, bytes, onProgress));
  }

  sync(files, onProgress) {
    return this.replTask(async () => {
      const paths = files.map((file) => file.path);
      const remote = paths.length ? await this.repl.execJson(`import ide; ide.hashes(${py(paths)})`, { timeout: 30000 }) : {};
      const changed = await changedFiles(files, remote);
      const total = changed.reduce((sum, file) => sum + file.bytes.length, 0);
      let done = 0;
      for (const file of changed) {
        await this.replWrite(file.path, file.bytes, (sent) => onProgress?.(done + sent, total, file.path));
        done += file.bytes.length;
      }
      return changed.map((file) => file.path);
    });
  }

  run(path, { debug = null, onOutput = null } = {}) {
    return this.replTask(async () => {
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
    await this.repl.link.write('\x03');
  }

  lock() {
    return Promise.resolve();
  }

  unlock() {
    return Promise.resolve();
  }

  async returnToLauncher() {
    if (this.running) await this.stop();
    return false;
  }
}
