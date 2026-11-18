import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTargetFor, badgeRunTarget, frozenSourcePath, librarySourcePath, appSlug, slugify, SCRATCH_PATH } from '../simulator/device/paths.js';

test('apps run as a whole, other files on their own', () => {
  assert.deepEqual(runTargetFor('/apps/snake/game.py'), { kind: 'app', slug: 'snake', path: '/apps/snake' });
  assert.deepEqual(runTargetFor('/contrib/blocks/__init__.py'), { kind: 'app', slug: 'blocks', path: '/contrib/blocks' });
  assert.deepEqual(runTargetFor('/hello.py'), { kind: 'file', path: '/hello.py' });
  assert.deepEqual(runTargetFor(null), { kind: 'scratch', path: SCRATCH_PATH });
  assert.equal(appSlug('/apps'), null);
  assert.equal(appSlug('/apps/snake/assets/a.png'), 'snake');
});

test('slugify makes folder names', () => {
  assert.equal(slugify('My Cool App!'), 'my_cool_app');
  assert.equal(slugify('  3D Cube '), '3d_cube');
});

test('launcher names match the badge menu', async () => {
  const { launcherName } = await import('../simulator/device/paths.js');
  assert.equal(launcherName('space_race'), 'Space Race');
  assert.equal(launcherName('3d_cube'), '3d Cube');
  assert.equal(launcherName('a_b_tree'), 'a b Tree');
});

test('locked tabs run their app on the badge when it is there', () => {
  const scratch = { kind: 'scratch', path: SCRATCH_PATH };
  const app = { kind: 'app', slug: 'clock', path: '/apps/clock' };
  const onBadge = (path) => path === '/apps/clock/__init__.py';
  assert.deepEqual(badgeRunTarget({ lockedPath: '/apps/clock/__init__.py', lockedSource: 'sys' }, onBadge), app);
  assert.deepEqual(badgeRunTarget({ lockedPath: '/apps/clock/face.py', lockedSource: 'badge' }, () => false), app);
  assert.deepEqual(badgeRunTarget({ lockedPath: '/contrib/blocks/__init__.py', lockedSource: 'sys' }, onBadge), scratch);
  assert.deepEqual(badgeRunTarget({ lockedPath: '/system/boot.py', lockedSource: 'sys' }, onBadge), scratch);
  assert.deepEqual(badgeRunTarget({ path: null }, onBadge), scratch);
  assert.deepEqual(badgeRunTarget({ path: '/apps/mine/__init__.py' }, onBadge), { kind: 'app', slug: 'mine', path: '/apps/mine' });
});

test('library frames map to the bundled source', () => {
  const bundle = ['/badgeware/text.py', '/badgeware/__init__.py'];
  assert.equal(librarySourcePath('badgeware/text.py', bundle), '/badgeware/text.py');
  assert.equal(librarySourcePath('.frozen/badgeware/__init__.py', bundle), '/badgeware/__init__.py');
  assert.equal(librarySourcePath('ide_debug.py', bundle), null);
  assert.equal(librarySourcePath('/apps/clock/__init__.py', bundle), null);
  assert.equal(librarySourcePath('<stdin>', bundle), null);
});

test('frozen frames map to the firmware sources when bundled', () => {
  const frozen = new Set(['badgeware/text.py', 'ide.py']);
  assert.equal(frozenSourcePath('badgeware/text.py', frozen), '/.frozen/badgeware/text.py');
  assert.equal(frozenSourcePath('ide.py', frozen), '/.frozen/ide.py');
  assert.equal(frozenSourcePath('wifi.py', frozen), null);
});
