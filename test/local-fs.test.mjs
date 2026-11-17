import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnoredPath, entryFromBytes, diffEntries, createLocalFS } from '../simulator/local-fs.js';

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

class FakeFile {
  constructor(name) {
    this.kind = 'file';
    this.name = name;
    this.bytes = new Uint8Array(0);
    this.modified = 0;
  }

  async getFile() {
    const bytes = this.bytes;
    return { size: bytes.length, lastModified: this.modified, arrayBuffer: async () => bytes.slice().buffer };
  }

  async createWritable() {
    const parts = [];
    return {
      write: async (bytes) => parts.push(bytes),
      close: async () => {
        this.bytes = Uint8Array.from(parts.flatMap((part) => [...part]));
        this.modified += 1;
      },
    };
  }
}

class FakeDirectory {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.children = new Map();
  }

  async *entries() {
    yield* this.children.entries();
  }

  child(name, Kind, create) {
    const existing = this.children.get(name);
    if (existing) return existing;
    if (!create) throw Object.assign(new Error(name), { name: 'NotFoundError' });
    const created = new Kind(name);
    this.children.set(name, created);
    return created;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    return this.child(name, FakeDirectory, create);
  }

  async getFileHandle(name, { create = false } = {}) {
    return this.child(name, FakeFile, create);
  }

  async removeEntry(name, { recursive = false } = {}) {
    const entry = this.children.get(name);
    if (!entry) throw Object.assign(new Error(name), { name: 'NotFoundError' });
    if (entry.kind === 'directory' && entry.children.size && !recursive) throw Object.assign(new Error(name), { name: 'InvalidModificationError' });
    this.children.delete(name);
  }

  file(path, text) {
    const names = path.split('/').filter(Boolean);
    let directory = this;
    for (const name of names.slice(0, -1)) directory = directory.child(name, FakeDirectory, true);
    const file = directory.child(names[names.length - 1], FakeFile, true);
    file.bytes = typeof text === 'string' ? encode(text) : text;
    file.modified += 1;
    return file;
  }

  find(path) {
    let entry = this;
    for (const name of path.split('/').filter(Boolean)) entry = entry?.children?.get(name);
    return entry ?? null;
  }
}

test('junk folders and dotfiles are skipped', () => {
  assert.equal(isIgnoredPath('/.git/config'), true);
  assert.equal(isIgnoredPath('/apps/clock/__pycache__/x.mpy'), true);
  assert.equal(isIgnoredPath('/node_modules/a/index.js'), true);
  assert.equal(isIgnoredPath('/.DS_Store'), true);
  assert.equal(isIgnoredPath('/apps/clock/__init__.py'), false);
  assert.equal(isIgnoredPath('/apps/my.app/icon.png'), false);
});

test('files are text when they decode as UTF-8', () => {
  assert.deepEqual(entryFromBytes('/a.py', encode('print(1)')), { text: 'print(1)', binary: false });
  assert.equal(entryFromBytes('/a.png', new Uint8Array([137, 80, 0, 1])).mimeType, 'image/png');
  assert.equal(entryFromBytes('/a.bin', new Uint8Array([0xff, 0xfe])).binary, true);
  assert.equal(entryFromBytes('/bom.py', encode('﻿x')).text, '﻿x');
});

test('diffs report added, removed and changed paths', () => {
  const before = { '/a.py': { text: 'a', binary: false }, '/b.py': { text: 'b', binary: false }, '/d/': { isDir: true } };
  const after = { '/a.py': { text: 'a', binary: false }, '/b.py': { text: 'B', binary: false }, '/c.py': { text: 'c', binary: false } };
  assert.deepEqual(diffEntries(before, after), { added: ['/c.py'], removed: ['/d/'], changed: ['/b.py'] });
});

test('a local folder loads, writes and picks up outside edits', async () => {
  const root = new FakeDirectory('project');
  root.file('/main.py', 'print("hi")');
  root.file('/apps/clock/__init__.py', 'clock');
  root.file('/apps/clock/__pycache__/x.mpy', 'junk');
  root.file('/.git/HEAD', 'ref');
  const fs = createLocalFS(root);
  await fs.ready;
  assert.deepEqual(fs.paths(), ['/apps/', '/apps/clock/', '/apps/clock/__init__.py', '/main.py']);
  assert.equal(fs.get('/main.py').text, 'print("hi")');

  fs.set('/new/file.txt', { text: 'new', binary: false });
  fs.set('/.hidden', { text: 'no', binary: false });
  await fs.flush();
  assert.equal(decode(root.find('/new/file.txt').bytes), 'new');
  assert.equal(root.find('/.hidden'), null);

  root.file('/main.py', 'print("edited")');
  root.file('/added.py', 'x');
  await root.removeEntry('new', { recursive: true });
  const changes = await fs.reload();
  assert.deepEqual(changes, { added: ['/added.py'], removed: ['/new/file.txt'], changed: ['/main.py'] });
  assert.equal(fs.get('/main.py').text, 'print("edited")');

  assert.deepEqual(await fs.reload(), { added: [], removed: [], changed: [] });
});

test('renames move files and leave ignored files alone', async () => {
  const root = new FakeDirectory('project');
  root.file('/apps/old/__init__.py', 'app');
  root.file('/apps/old/__pycache__/x.mpy', 'junk');
  const fs = createLocalFS(root);
  await fs.ready;
  await fs.rename('/apps/old', '/apps/new');
  assert.deepEqual(fs.paths(), ['/apps/', '/apps/new/', '/apps/new/__init__.py']);
  assert.equal(decode(root.find('/apps/new/__init__.py').bytes), 'app');
  assert.equal(root.find('/apps/old/__init__.py'), null);
  assert.ok(root.find('/apps/old/__pycache__/x.mpy'));
});

test('deleting a folder removes it from disk', async () => {
  const root = new FakeDirectory('project');
  root.file('/apps/gone/__init__.py', 'app');
  const fs = createLocalFS(root);
  await fs.ready;
  fs.del('/apps/gone/');
  fs.del('/apps/gone/__init__.py');
  await fs.flush();
  assert.equal(root.find('/apps/gone'), null);
  assert.deepEqual(fs.paths(), ['/apps/']);
});
