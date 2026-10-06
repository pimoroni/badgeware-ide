export class LinkTimeoutError extends Error {
  constructor(message, partial) {
    super(message);
    this.name = 'LinkTimeoutError';
    this.partial = partial;
  }
}

export class LinkClosedError extends Error {
  constructor() {
    super('serial port closed');
    this.name = 'LinkClosedError';
  }
}

const encoder = new TextEncoder();
const CLOSE_TIMEOUT_MS = 1000;

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

export const toBytes = (data) => (data instanceof Uint8Array ? data : encoder.encode(data));

function indexOf(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export class SerialLink {
  constructor(port, { baudRate = 115200, bufferSize = 255 } = {}) {
    this.port = port;
    this.baudRate = baudRate;
    this.bufferSize = bufferSize;
    this.buffer = new Uint8Array(0);
    this.waiters = new Set();
    this.closed = true;
    this.onData = null;
  }

  async open() {
    await this.port.open({ baudRate: this.baudRate, bufferSize: this.bufferSize });
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: false });
    this.closed = false;
    this.writer = this.port.writable.getWriter();
    this.pumping = this.pump();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.reader?.cancel(); } catch (_) {}
    await withTimeout(this.pumping?.catch(() => {}), CLOSE_TIMEOUT_MS);
    try { await withTimeout(this.writer.abort(), CLOSE_TIMEOUT_MS); } catch (_) {}
    try { this.writer.releaseLock(); } catch (_) {}
    try { await withTimeout(this.port.close(), CLOSE_TIMEOUT_MS); } catch (_) {}
    this.wake();
  }

  async pump() {
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value?.length) continue;
        if (this.onData) {
          this.onData(value);
          continue;
        }
        const merged = new Uint8Array(this.buffer.length + value.length);
        merged.set(this.buffer);
        merged.set(value, this.buffer.length);
        this.buffer = merged;
        this.wake();
      }
    } catch (_) {
    } finally {
      try { this.reader.releaseLock(); } catch (_) {}
      this.closed = true;
      this.wake();
    }
  }

  wake() {
    const waiters = [...this.waiters];
    this.waiters.clear();
    waiters.forEach((resolve) => resolve());
  }

  waitForData(timeoutMs) {
    if (this.closed) throw new LinkClosedError();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => { this.waiters.delete(done); resolve(); }, Math.max(0, timeoutMs)) : null;
      this.waiters.add(done);
    });
  }

  take(count) {
    const out = this.buffer.slice(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  get available() {
    return this.buffer.length;
  }

  async write(data) {
    if (this.closed) throw new LinkClosedError();
    await this.writer.write(toBytes(data));
  }

  discard() {
    this.buffer = new Uint8Array(0);
  }

  async readExactly(count, { timeout = 5000 } = {}) {
    const deadline = performance.now() + timeout;
    while (this.buffer.length < count) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new LinkTimeoutError(`timed out reading ${count} bytes`, this.take(this.buffer.length));
      await this.waitForData(remaining);
    }
    return this.take(count);
  }

  async readUntil(ending, { timeout = 5000, onChunk = null } = {}) {
    const needle = toBytes(ending);
    const chunks = [];
    let idleDeadline = performance.now() + timeout;
    for (;;) {
      const index = indexOf(this.buffer, needle);
      if (index >= 0) {
        const got = this.take(index + needle.length);
        if (onChunk && index > 0) onChunk(got.subarray(0, index));
        chunks.push(got);
        break;
      }
      const keep = needle.length - 1;
      if (this.buffer.length > keep) {
        const safe = this.take(this.buffer.length - keep);
        onChunk?.(safe);
        chunks.push(safe);
        idleDeadline = performance.now() + timeout;
      }
      const remaining = idleDeadline - performance.now();
      if (remaining <= 0) throw new LinkTimeoutError(`timed out waiting for ${JSON.stringify(new TextDecoder().decode(needle))}`, concat(chunks));
      await this.waitForData(remaining);
    }
    return concat(chunks);
  }

  async drain({ idleMs = 80, maxMs = 1500 } = {}) {
    const deadline = performance.now() + maxMs;
    while (performance.now() < deadline) {
      this.discard();
      await this.waitForData(Math.min(idleMs, deadline - performance.now()));
      if (this.buffer.length === 0) return;
    }
    this.discard();
  }
}

export function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
