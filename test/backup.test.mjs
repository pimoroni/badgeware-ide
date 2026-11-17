import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupName, backupPaths, badgePathFromZip, planRestore, backupBadge, restoreBadge } from '../simulator/device/backup.js';
import { readZip } from '../simulator/zip.js';

const encode = (text) => new TextEncoder().encode(text);

const listing = [
  ['/apps', -1],
  ['/apps/clock', -1],
  ['/apps/clock/__init__.py', 10],
  ['/apps/old', -1],
  ['/apps/old/__init__.py', 5],
  ['/apps/old/icon.png', 50],
  ['/notes.txt', 3],
  ['/rom', -1],
  ['/rom/fonts', -1],
  ['/rom/fonts/sins.ppf', 900],
  ['/secrets.py', 40],
];

test('backup names use the date', () => {
  assert.equal(backupName(new Date(2026, 0, 5)), 'tufty-backup-2026-01-05.zip');
  assert.equal(backupName(new Date(2026, 0, 5), 'badger'), 'badger-backup-2026-01-05.zip');
});

test('backups skip the ROM and leave out secrets.py unless asked', () => {
  const paths = backupPaths(listing).map((entry) => entry.path);
  assert.ok(!paths.some((path) => path.startsWith('/rom')));
  assert.ok(!paths.includes('/secrets.py'));
  assert.ok(backupPaths(listing, { includeSecrets: true }).some((entry) => entry.path === '/secrets.py'));
});

test('zip names map to safe badge paths', () => {
  assert.equal(badgePathFromZip('apps/clock/__init__.py'), '/apps/clock/__init__.py');
  assert.equal(badgePathFromZip('/apps/'), '/apps');
  assert.equal(badgePathFromZip('../etc/passwd'), null);
  assert.equal(badgePathFromZip(''), null);
});

test('restore writes every file and keeps extras by default', () => {
  const zipFiles = [
    { path: 'apps/', isDir: true, bytes: new Uint8Array(0) },
    { path: 'apps/clock/__init__.py', isDir: false, bytes: encode('clock') },
    { path: 'apps/new/', isDir: true, bytes: new Uint8Array(0) },
    { path: 'hello.py', isDir: false, bytes: encode('hi') },
    { path: '__MACOSX/._hello.py', isDir: false, bytes: encode('x') },
    { path: 'rom/fonts/x.ppf', isDir: false, bytes: encode('x') },
  ];
  const plan = planRestore(zipFiles, listing);
  assert.deepEqual(plan.write.map((file) => [file.path, file.exists]), [['/apps/clock/__init__.py', true], ['/hello.py', false]]);
  assert.deepEqual(plan.mkdir, ['/apps/new']);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.skipped, ['/rom/fonts/x.ppf']);
});

test('restore can delete extras but never the ROM or secrets.py', () => {
  const zipFiles = [{ path: 'apps/clock/__init__.py', isDir: false, bytes: encode('clock') }];
  const plan = planRestore(zipFiles, listing, { deleteExtras: true });
  assert.deepEqual(plan.remove, ['/apps/old', '/notes.txt']);
});

function fakeDevice(files) {
  const calls = [];
  return {
    calls,
    files,
    running: false,
    list: async () => Object.keys(files).sort().map((path) => [path, files[path] === null ? -1 : files[path].length]),
    read: async (path) => files[path],
    lock: async () => calls.push('lock'),
    unlock: async () => calls.push('unlock'),
    remove: async (path) => { calls.push('remove ' + path); delete files[path]; },
    makeDirectory: async (path) => { calls.push('mkdir ' + path); files[path] = null; },
    sync: async (written, onProgress) => {
      for (const file of written) {
        files[file.path] = file.bytes;
        onProgress(file.bytes.length, file.bytes.length, file.path);
      }
      calls.push('sync');
      return written.map((file) => file.path);
    },
  };
}

test('back up then restore with a fake badge', async () => {
  const device = fakeDevice({ '/apps': null, '/apps/a.py': encode('a'), '/secrets.py': encode('pw'), '/rom': null, '/rom/f': encode('f') });
  const { zip, fileCount } = await backupBadge(device);
  assert.equal(fileCount, 1);
  const files = await readZip(zip);
  assert.deepEqual(files.map((file) => file.path), ['apps/', 'apps/a.py']);

  device.files['/extra.py'] = encode('x');
  device.files['/apps/a.py'] = encode('changed');
  const plan = planRestore(files, await device.list('/'), { deleteExtras: true });
  const result = await restoreBadge(device, plan);
  assert.deepEqual(result, { written: 1, removed: 1 });
  assert.deepEqual(device.calls, ['lock', 'remove /extra.py', 'sync', 'unlock']);
  assert.deepEqual(device.files['/apps/a.py'], encode('a'));
  assert.ok(device.files['/secrets.py']);
});
