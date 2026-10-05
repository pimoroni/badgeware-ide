import { LinkTimeoutError } from './serial-link.js';

const RAW_BANNER = 'raw REPL; CTRL-B to exit\r\n>';
const SOFT_REBOOT = 'soft reboot\r\n';
const EOT = '\x04';

export class ReplError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplError';
  }
}

export class DeviceExecError extends Error {
  constructor(stdout, stderr) {
    super(stderr.trim().split('\n').pop() || 'exception on device');
    this.name = 'DeviceExecError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function streamDecoder(callback) {
  if (!callback) return null;
  const decoder = new TextDecoder();
  return (bytes) => callback(decoder.decode(bytes, { stream: true }));
}

export class RawRepl {
  constructor(link) {
    this.link = link;
    this.inRaw = false;
  }

  async interrupt() {
    for (let i = 0; i < 2; i++) {
      await this.link.write('\r\x03');
      await this.link.drain();
    }
  }

  async enter({ softReset = true, attempts = 3 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.interrupt();
        await this.link.write('\r\x01');
        await this.link.readUntil(RAW_BANNER, { timeout: 2000 });
        if (softReset) {
          await this.link.write('\x04');
          await this.link.readUntil(SOFT_REBOOT, { timeout: 3000 });
          await this.link.readUntil(RAW_BANNER, { timeout: 8000 });
        }
        this.inRaw = true;
        return;
      } catch (error) {
        if (!(error instanceof LinkTimeoutError)) throw error;
        lastError = error;
      }
    }
    const heard = new TextDecoder().decode(lastError?.partial ?? new Uint8Array()).trim().slice(-120);
    throw new ReplError(`The badge did not respond to the raw REPL. ${heard ? `Last output: ${JSON.stringify(heard)}` : 'It sent nothing.'}`);
  }

  async exit() {
    await this.link.write('\r\x02');
    this.inRaw = false;
  }

  async restartFirmware() {
    await this.link.write('\r\x02');
    await sleep(50);
    await this.link.write('\x04');
    this.inRaw = false;
  }

  async start(code) {
    if (!this.inRaw) throw new ReplError('not in raw REPL');
    const bytes = new TextEncoder().encode(code);
    for (let offset = 0; offset < bytes.length; offset += 256) {
      await this.link.write(bytes.subarray(offset, offset + 256));
      if (offset + 256 < bytes.length) await sleep(10);
    }
    await this.link.write(EOT);
    const ok = new TextDecoder().decode(await this.link.readExactly(2, { timeout: 2000 }));
    if (ok !== 'OK') throw new ReplError(`could not run command (got ${JSON.stringify(ok)})`);
  }

  async follow({ timeout = 10000, onStdout = null, onStderr = null } = {}) {
    const decoder = new TextDecoder();
    const stdout = await this.link.readUntil(EOT, { timeout, onChunk: streamDecoder(onStdout) });
    const stderr = await this.link.readUntil(EOT, { timeout, onChunk: streamDecoder(onStderr) });
    await this.link.readUntil('>', { timeout: 2000 });
    return {
      stdout: decoder.decode(stdout.subarray(0, -1)),
      stderr: decoder.decode(stderr.subarray(0, -1)),
    };
  }

  async exec(code, options = {}) {
    await this.start(code);
    const result = await this.follow(options);
    if (result.stderr) throw new DeviceExecError(result.stdout, result.stderr);
    return result.stdout;
  }

  async execJson(code, options) {
    const text = await this.exec(code, options);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new ReplError(`Unexpected reply from badge: ${JSON.stringify(text.slice(0, 200))}`);
    }
  }
}
