const TEXT_EXTENSIONS = ['.py', '.json', '.txt', '.md', '.csv', '.toml', '.ini', '.html', '.css', '.js'];
const FLUSH_DELAY_MS = 400;

const MIME_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

const extension = (path) => path.slice(path.lastIndexOf('.')).toLowerCase();
const isText = (path) => TEXT_EXTENSIONS.includes(extension(path));
export const isReadOnlyPath = (path) => path === '/rom' || path.startsWith('/rom/');

export function createBadgeFS(device, { onChange = () => {}, onError = () => {} } = {}) {
  let entries = {};
  const dirty = new Set();
  let flushTimer = null;
  let flushing = Promise.resolve();

  function reject(path) {
    onError(new Error(`${path} is read-only`));
    return false;
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    if (!device.running) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  function flush() {
    clearTimeout(flushTimer);
    flushing = flushing.then(async () => {
      for (const path of [...dirty]) {
        const entry = entries[path];
        dirty.delete(path);
        if (!entry || entry.isDir || entry.unloaded) continue;
        try {
          await device.write(path, entry.binary ? entry.data : new TextEncoder().encode(entry.text));
        } catch (error) {
          dirty.add(path);
          onError(error);
          return;
        }
      }
    });
    return flushing;
  }

  async function reload() {
    if (!device.connected) {
      entries = {};
      dirty.clear();
      onChange();
      return;
    }
    const listing = await device.list('/');
    const next = {};
    for (const [path, size] of listing) {
      if (size < 0) {
        next[path + '/'] = { isDir: true, readOnly: isReadOnlyPath(path) };
        continue;
      }
      const known = entries[path];
      next[path] = known && !known.unloaded && (dirty.has(path) || known.size === size)
        ? known
        : { unloaded: true, size, readOnly: isReadOnlyPath(path) };
    }
    entries = next;
    onChange();
  }

  device.addEventListener('stopped', () => { if (dirty.size) flush(); });
  device.addEventListener('disconnected', reload);

  return {
    ready: Promise.resolve(),
    reload,
    flush,
    get: (path) => entries[path] ?? null,
    paths: () => Object.keys(entries).sort(),
    workerFiles: () => [],

    async load(path) {
      const entry = entries[path];
      if (!entry?.unloaded) return entry ?? null;
      const bytes = await device.read(path);
      entries[path] = isText(path)
        ? { text: new TextDecoder().decode(bytes), binary: false, size: bytes.length, readOnly: entry.readOnly }
        : { data: bytes, binary: true, mimeType: MIME_TYPES[extension(path)] ?? 'application/octet-stream', size: bytes.length, readOnly: entry.readOnly };
      return entries[path];
    },

    set(path, value) {
      if (isReadOnlyPath(path)) return reject(path);
      if (value.isDir) {
        entries[path] = value;
        device.makeDirectory(path.replace(/\/+$/, '')).catch(onError);
        return true;
      }
      const size = value.binary ? value.data.length : new TextEncoder().encode(value.text).length;
      entries[path] = { ...value, size };
      dirty.add(path);
      scheduleFlush();
      return true;
    },

    del(path) {
      if (isReadOnlyPath(path)) return reject(path);
      delete entries[path];
      dirty.delete(path);
      device.remove(path.replace(/\/+$/, '')).catch(onError);
      return true;
    },

    async rename(from, to) {
      if (isReadOnlyPath(from) || isReadOnlyPath(to)) throw new Error('/rom is read-only');
      await flush();
      await device.rename(from, to);
      for (const path of Object.keys(entries)) {
        if (path !== from && path !== from + '/' && !path.startsWith(from + '/')) continue;
        entries[to + path.slice(from.length)] = entries[path];
        delete entries[path];
      }
      onChange();
    },
  };
}
