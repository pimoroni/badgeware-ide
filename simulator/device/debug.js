import { SerialLink } from './serial-link.js';

const READ_BUFFER_SIZE = 512 * 1024;
const PAYLOAD_STALL_MS = 1500;

function concatChunks(chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function dispatchPayload(client, message, chunks) {
  client.dispatch({ ...message, payload: concatChunks(chunks) });
}

export class DebugClient extends EventTarget {
  constructor(port) {
    super();
    this.link = new SerialLink(port, { bufferSize: READ_BUFFER_SIZE });
    this.decoder = new TextDecoder();
    this.lineChunks = [];
    this.binary = null;
  }

  async open() {
    this.link.onData = (bytes) => this.receive(bytes);
    await this.link.open();
  }

  async close() {
    clearTimeout(this.stallTimer);
    await this.link.close();
    this.dispatchEvent(new CustomEvent('closed'));
  }

  dispatch(message) {
    this.dispatchEvent(new CustomEvent(message.event, { detail: message }));
    this.dispatchEvent(new CustomEvent('message', { detail: message }));
  }

  watchPayload() {
    clearTimeout(this.stallTimer);
    if (!this.binary) return;
    this.stallTimer = setTimeout(() => {
      const { message, remaining } = this.binary;
      this.binary = null;
      this.dispatch({ event: 'error', id: message.id, message: `Debugger "${message.event}" was ${remaining} bytes short.` });
    }, PAYLOAD_STALL_MS);
  }

  receive(bytes) {
    this.receiveBytes(bytes);
    this.watchPayload();
  }

  receiveBytes(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.binary) {
        const take = Math.min(this.binary.remaining, bytes.length - offset);
        this.binary.chunks.push(bytes.subarray(offset, offset + take));
        this.binary.remaining -= take;
        offset += take;
        if (this.binary.remaining === 0) {
          const { message, chunks } = this.binary;
          this.binary = null;
          dispatchPayload(this, message, chunks);
        }
        continue;
      }
      const newline = bytes.indexOf(10, offset);
      if (newline < 0) {
        this.lineChunks.push(bytes.slice(offset));
        return;
      }
      this.lineChunks.push(bytes.subarray(offset, newline));
      offset = newline + 1;
      const line = this.decoder.decode(concatChunks(this.lineChunks)).trim();
      this.lineChunks = [];
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (message.bytes > 0) this.binary = { message, chunks: [], remaining: message.bytes };
      else this.dispatch(message);
    }
  }

  send(command) {
    return this.link.write(JSON.stringify(command) + '\n');
  }

  waitFor(event, timeout = 5000, predicate = null, id = null) {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.removeEventListener(event, handler);
        this.removeEventListener('error', onError);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`Debugger did not send "${event}".`));
      }, timeout);
      const handler = ({ detail }) => {
        if (predicate && !predicate(detail)) return;
        finish();
        resolve(detail);
      };
      const onError = ({ detail }) => {
        if (id === null || (detail.id != null && detail.id !== id)) return;
        finish();
        reject(new Error(detail.message));
      };
      this.addEventListener(event, handler);
      this.addEventListener('error', onError);
    });
  }

  async request(command, event, timeout = 5000) {
    const id = Math.random().toString(36).slice(2);
    const reply = this.waitFor(event, timeout, (detail) => detail.id === id, id);
    await this.send({ ...command, id });
    return reply;
  }
}
