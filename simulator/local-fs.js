const IGNORED_NAMES = new Set(['node_modules', '__pycache__']);
const MAX_ENTRIES = 2000;
const MIME_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', wav: 'audio/wav', json: 'application/json' };

export const isIgnoredName = (name) => name.startsWith('.') || IGNORED_NAMES.has(name);
export const isIgnoredPath = (path) => path.split('/').filter(Boolean).some(isIgnoredName);

const mimeType = (path) => MIME_TYPES[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
const pathParts = (path) => path.split('/').filter(Boolean);

export function entryFromBytes(path, bytes) {
  if (!bytes.includes(0)) {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), binary: false };
    } catch (_) {}
  }
  return { data: bytes, binary: true, mimeType: mimeType(path) };
}

export const entryBytes = (entry) => (entry.binary ? entry.data : new TextEncoder().encode(entry.text));

function sameEntry(a, b) {
  if (a.isDir || b.isDir) return !!a.isDir === !!b.isDir;
  const left = entryBytes(a);
  const right = entryBytes(b);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function diffEntries(before, after) {
  const added = Object.keys(after).filter((path) => !(path in before));
  const removed = Object.keys(before).filter((path) => !(path in after));
  const changed = Object.keys(after).filter((path) => path in before && !sameEntry(before[path], after[path]));
  return { added, removed, changed };
}

async function walkDirectory(directory, prefix, found) {
  for await (const [name, handle] of directory.entries()) {
    if (isIgnoredName(name)) continue;
    const path = `${prefix}/${name}`;
    if (found.length >= MAX_ENTRIES) throw new Error(`That folder has more than ${MAX_ENTRIES} files. Pick a smaller one.`);
    if (handle.kind === 'directory') {
      found.push({ path: path + '/', handle });
      await walkDirectory(handle, path, found);
    } else {
      found.push({ path, handle });
    }
  }
  return found;
}

export function createLocalFS(root) {
  let data = {};
  let stamps = {};
  let touched = null;
  let reloading = null;

  let writeChain = Promise.resolve();
  const enqueue = (work) => {
    writeChain = writeChain.then(work).catch((error) => console.error('Local folder write failed', error));
    return writeChain;
  };

  async function directoryAt(names, create) {
    let directory = root;
    for (const name of names) directory = await directory.getDirectoryHandle(name, { create });
    return directory;
  }

  async function writeFile(path, entry) {
    const names = pathParts(path);
    const directory = await directoryAt(names.slice(0, -1), true);
    const file = await directory.getFileHandle(names[names.length - 1], { create: true });
    const writable = await file.createWritable();
    await writable.write(entryBytes(entry));
    await writable.close();
  }

  const writeEntry = (path, entry) => (entry.isDir ? directoryAt(pathParts(path), true) : writeFile(path, entry));

  async function removePath(path, recursive) {
    const names = pathParts(path);
    try {
      const directory = await directoryAt(names.slice(0, -1), false);
      await directory.removeEntry(names[names.length - 1], { recursive });
    } catch (error) {
      if (error.name !== 'NotFoundError' && error.name !== 'InvalidModificationError') throw error;
    }
  }

  async function scan() {
    const next = {};
    const nextStamps = {};
    for (const { path, handle } of await walkDirectory(root, '', [])) {
      if (path.endsWith('/')) {
        next[path] = { isDir: true };
        continue;
      }
      const file = await handle.getFile();
      const stamp = `${file.size}:${file.lastModified}`;
      nextStamps[path] = stamp;
      next[path] = stamps[path] === stamp && data[path]
        ? data[path]
        : entryFromBytes(path, new Uint8Array(await file.arrayBuffer()));
    }
    return { next, nextStamps };
  }

  async function reloadNow() {
    await writeChain;
    touched = new Set();
    try {
      const { next, nextStamps } = await scan();
      for (const path of touched) {
        if (path in data) next[path] = data[path];
        else delete next[path];
      }
      const changes = diffEntries(data, next);
      data = next;
      stamps = nextStamps;
      return changes;
    } finally {
      touched = null;
    }
  }

  const reload = () => (reloading ??= reloadNow().finally(() => { reloading = null; }));

  function forget(path) {
    delete data[path];
    delete stamps[path];
    touched?.add(path);
  }

  function put(path, value) {
    data[path] = value;
    touched?.add(path);
  }

  return {
    ready: reload().then(() => {}),
    reload,
    name: root.name,
    get: (path) => data[path] ?? null,
    paths: () => Object.keys(data).sort(),
    flush: () => writeChain,
    workerFiles: () => Object.entries(data).map(([name, entry]) => ({ name, content: entry.binary ? entry.data : entry.text })),

    set(path, value) {
      if (isIgnoredPath(path)) return;
      put(path, value);
      enqueue(() => writeEntry(path, value));
    },

    del(path) {
      forget(path);
      if (path.endsWith('/')) {
        for (const child of Object.keys(data).filter((key) => key.startsWith(path))) forget(child);
      }
      enqueue(() => removePath(path, path.endsWith('/')));
    },

    async rename(from, to) {
      const moved = Object.keys(data)
        .filter((path) => path === from || path === from + '/' || path.startsWith(from + '/'))
        .sort()
        .map((path) => ({ path, target: to + path.slice(from.length), entry: data[path] }));
      for (const { path, target, entry } of moved) {
        forget(path);
        put(target, entry);
      }
      enqueue(async () => {
        for (const { target, entry } of moved) await writeEntry(target, entry);
        for (const { path } of moved.filter((item) => !item.entry.isDir)) await removePath(path, false);
        for (const { path } of moved.filter((item) => item.entry.isDir).reverse()) await removePath(path, false);
      });
      await writeChain;
    },
  };
}
