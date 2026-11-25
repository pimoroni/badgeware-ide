import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebugSources, frameSourcePath, scratchKeyFor, tabTarget } from '../simulator/debug-sources.js';

const frozenFiles = new Set(['badgeware/text.py']);
const systemPaths = ['/badgeware/text.py', '/badgeware/shapes.py'];

test('maps user frames to their own file, including scratch', () => {
  assert.equal(frameSourcePath({ user: true, file: '/apps/a/__init__.py' }, frozenFiles, systemPaths), '/apps/a/__init__.py');
  assert.equal(frameSourcePath({ user: true, file: '/.ide/scratch.py' }, frozenFiles, systemPaths), '/.ide/scratch.py');
});

test('maps library frames to frozen sources before bundled copies', () => {
  assert.equal(frameSourcePath({ user: false, file: 'badgeware/text.py' }, frozenFiles, systemPaths), '/.frozen/badgeware/text.py');
  assert.equal(frameSourcePath({ user: false, file: 'badgeware/shapes.py' }, frozenFiles, systemPaths), '/badgeware/shapes.py');
  assert.equal(frameSourcePath({ user: false, file: 'badgeware/missing.py' }, frozenFiles, systemPaths), null);
  assert.equal(frameSourcePath({ user: false, file: '<stdin>' }, frozenFiles, systemPaths), null);
});

test('targets the scratch path only for the scratch tab being debugged', () => {
  const scratch = { view: 'editor', source: 'scratch', name: 'one' };
  const other = { view: 'editor', source: 'scratch', name: 'two' };
  const key = scratchKeyFor(scratch);
  assert.equal(key, 'scratch:one');
  assert.deepEqual(tabTarget(scratch, key), { key: 'scratch:one', file: '/.ide/scratch.py' });
  assert.deepEqual(tabTarget(other, key), { key: 'scratch:two', file: 'scratch:two' });
  assert.deepEqual(tabTarget(scratch, null), { key: 'scratch:one', file: 'scratch:one' });
  assert.equal(scratchKeyFor({ source: 'user', path: '/a.py' }), null);
});

test('targets python files in user, badge and system tabs', () => {
  for (const source of ['user', 'badge', 'sys']) {
    assert.deepEqual(tabTarget({ view: 'editor', source, path: '/a/b.py' }, null), { key: '/a/b.py', file: '/a/b.py' });
  }
  assert.equal(tabTarget({ view: 'editor', source: 'user', path: '/a/b.txt' }, null), null);
  assert.equal(tabTarget({ view: 'image', source: 'user', path: '/a/b.py' }, null), null);
  assert.equal(tabTarget(null, null), null);
});

function fakeTabs(openPaths = []) {
  const calls = [];
  return {
    calls,
    focusKey: (key) => calls.push(['focusKey', key]),
    focusPath: (path) => {
      if (!openPaths.includes(path)) return false;
      calls.push(['focusPath', path]);
      return true;
    },
    openBadgeFile: async (path, loader) => calls.push(['openBadgeFile', path, typeof loader]),
    openFile: async (path, options) => calls.push(['openFile', path, options]),
  };
}

function sourcesWith(tabs, { badgeFiles = [] } = {}) {
  const provider = {
    frozenFiles: () => frozenFiles,
    readFrozen: async () => null,
  };
  return createDebugSources({
    tabs,
    provider,
    systemPaths: () => systemPaths,
    inWorkspace: (path) => path === '/apps/a/__init__.py',
    openBadgeFile: async (path) => badgeFiles.push(path),
  });
}

test('shows sources from open tabs, frozen bundles, the workspace, the badge and the library', async () => {
  const tabs = fakeTabs(['/apps/open.py']);
  const badgeFiles = [];
  const sources = sourcesWith(tabs, { badgeFiles });
  await sources.showSource('/apps/open.py', true);
  await sources.showSource('/.frozen/badgeware/text.py', false);
  await sources.showSource('/badgeware/shapes.py', false);
  await sources.showSource('/apps/a/__init__.py', true);
  await sources.showSource('/apps/b/__init__.py', true);
  assert.deepEqual(tabs.calls, [
    ['focusPath', '/apps/open.py'],
    ['openBadgeFile', '/.frozen/badgeware/text.py', 'function'],
    ['openFile', '/badgeware/shapes.py', { system: true }],
    ['openFile', '/apps/a/__init__.py', undefined],
  ]);
  assert.deepEqual(badgeFiles, ['/apps/b/__init__.py']);
});

test('shows the scratch tab captured when debugging started', async () => {
  const tabs = fakeTabs();
  const sources = sourcesWith(tabs);
  await sources.showSource('/.ide/scratch.py', true);
  sources.captureScratch({ view: 'editor', source: 'scratch', name: 'one' });
  await sources.showSource('/.ide/scratch.py', true);
  assert.deepEqual(tabs.calls, [['focusKey', 'scratch:one']]);
  assert.deepEqual(sources.target({ view: 'editor', source: 'scratch', name: 'one' }), { key: 'scratch:one', file: '/.ide/scratch.py' });
  sources.captureScratch({ view: 'editor', source: 'user', path: '/a.py' });
  assert.equal(sources.scratchKey, null);
});

test('maps a frozen library frame to its frozen source', () => {
  const sources = sourcesWith(fakeTabs());
  const frame = { user: false, file: 'badgeware/text.py', name: 'update', first: 1 };
  assert.equal(sources.sourcePath(frame), '/.frozen/badgeware/text.py');
});
