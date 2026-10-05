import { SerialLink } from './serial-link.js';

export class DebugClient extends EventTarget {
  constructor(port) {
    super();
    this.link = new SerialLink(port);
    this.pending = '';
    this.decoder = new TextDecoder();
  }

  async open() {
    this.link.onData = (bytes) => this.receive(bytes);
    await this.link.open();
  }

  async close() {
    await this.link.close();
    this.dispatchEvent(new CustomEvent('closed'));
  }

  receive(bytes) {
    this.pending += this.decoder.decode(bytes, { stream: true });
    let newline;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        continue;
      }
      this.dispatchEvent(new CustomEvent(message.event, { detail: message }));
      this.dispatchEvent(new CustomEvent('message', { detail: message }));
    }
  }

  send(command) {
    return this.link.write(JSON.stringify(command) + '\n');
  }

  waitFor(event, timeout = 5000, predicate = null) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeEventListener(event, handler);
        reject(new Error(`Debugger did not send "${event}".`));
      }, timeout);
      const handler = ({ detail }) => {
        if (predicate && !predicate(detail)) return;
        clearTimeout(timer);
        this.removeEventListener(event, handler);
        resolve(detail);
      };
      this.addEventListener(event, handler);
    });
  }

  async request(command, event, timeout = 5000) {
    const id = Math.random().toString(36).slice(2);
    const reply = this.waitFor(event, timeout, (detail) => detail.id === id);
    await this.send({ ...command, id });
    return reply;
  }
}
