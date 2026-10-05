import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRIDGE = fileURLToPath(new URL('../tools/serial_bridge.py', import.meta.url));
const PYTHON = process.env.BADGE_PYTHON || 'python3';

export class BridgePort {
  constructor(path) {
    this.path = path;
  }

  getInfo() {
    return { usbVendorId: 0x2e8a, usbProductId: 0x1101 };
  }

  async open() {
    this.child = spawn(PYTHON, [BRIDGE, this.path], { stdio: ['pipe', 'pipe', 'inherit'] });
    const child = this.child;
    this.readable = new ReadableStream({
      start(controller) {
        child.stdout.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
        child.stdout.on('end', () => { try { controller.close(); } catch (_) {} });
      },
      cancel() { child.kill(); },
    });
    this.writable = new WritableStream({
      write(chunk) {
        return new Promise((resolve, reject) => child.stdin.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve())));
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  async setSignals() {}

  async close() {
    this.child?.kill();
    this.child = null;
  }
}

export function bridgeSerial(paths) {
  const ports = paths.map((path) => new BridgePort(path));
  return {
    getPorts: async () => ports,
    requestPort: async () => ports[0],
    addEventListener() {},
    removeEventListener() {},
  };
}
