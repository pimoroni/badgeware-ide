(() => {
  const bridge = window.__BADGE_BRIDGE__;
  if (!bridge) return;

  class BridgedPort extends EventTarget {
    constructor(path) {
      super();
      this.path = path;
    }

    getInfo() {
      return { usbVendorId: 0x2e8a, usbProductId: 0x1101 };
    }

    async open() {
      const socket = new WebSocket(bridge.url + this.path);
      socket.binaryType = 'arraybuffer';
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
      });
      this.socket = socket;
      this.readable = new ReadableStream({
        start(controller) {
          socket.onmessage = ({ data }) => controller.enqueue(new Uint8Array(data));
          socket.onclose = () => { try { controller.close(); } catch (_) {} };
        },
        cancel() { socket.close(); },
      });
      this.writable = new WritableStream({ write(chunk) { socket.send(chunk); } });
    }

    async setSignals() {}

    async close() {
      this.socket?.close();
    }
  }

  const ports = bridge.ports.map((path) => new BridgedPort(path));
  const serial = new EventTarget();
  serial.getPorts = async () => ports;
  serial.requestPort = async () => ports[0];
  Object.defineProperty(navigator, 'serial', { value: serial });
})();
