import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDevicePath, toUserPath, runTargetFor, appSlug, slugify, SCRATCH_PATH } from '../simulator/device/paths.js';

test('app files map into /system/apps and back', () => {
  assert.equal(toDevicePath('/apps/snake/__init__.py'), '/system/apps/snake/__init__.py');
  assert.equal(toDevicePath('/apps/snake'), '/system/apps/snake');
  assert.equal(toUserPath('/system/apps/snake/assets/a.png'), '/apps/snake/assets/a.png');
  assert.equal(toUserPath('/system/apps/menu/app.py'), '/apps/menu/app.py');
});

test('loose files keep their path', () => {
  assert.equal(toDevicePath('/hello.py'), '/hello.py');
  assert.equal(toUserPath('/hello.py'), '/hello.py');
  assert.equal(toUserPath('badgeware/__init__.py'), 'badgeware/__init__.py');
});

test('run target picks the app for any file inside it', () => {
  assert.deepEqual(runTargetFor('/apps/snake/game.py'), { kind: 'app', slug: 'snake', userPath: '/apps/snake', devicePath: '/system/apps/snake' });
  assert.deepEqual(runTargetFor('/hello.py'), { kind: 'file', userPath: '/hello.py', devicePath: '/hello.py' });
  assert.deepEqual(runTargetFor(null), { kind: 'scratch', devicePath: SCRATCH_PATH });
  assert.equal(appSlug('/apps'), null);
});

test('slugify makes importable directory names', () => {
  assert.equal(slugify('My Cool App!'), 'my_cool_app');
  assert.equal(slugify('  3D Cube '), '3d_cube');
});

test('badge mode runs apps in place', async () => {
  const { badgeRunTarget, pathMapFor } = await import('../simulator/device/paths.js');
  assert.deepEqual(badgeRunTarget('/system/apps/snake/game.py'), { kind: 'app', slug: 'snake', devicePath: '/system/apps/snake' });
  assert.deepEqual(badgeRunTarget('/hello.py'), { kind: 'file', devicePath: '/hello.py' });
  assert.equal(badgeRunTarget(null).kind, 'scratch');
  assert.equal(pathMapFor('badge').toEditor('/system/apps/x/a.py'), '/system/apps/x/a.py');
  assert.equal(pathMapFor('simulator').toEditor('/system/apps/x/a.py'), '/apps/x/a.py');
});

test('launcher names match the badge menu', async () => {
  const { launcherName } = await import('../simulator/device/paths.js');
  assert.equal(launcherName('space_race'), 'Space Race');
  assert.equal(launcherName('3d_cube'), '3d Cube');
  assert.equal(launcherName('a_b_tree'), 'a b Tree');
});
