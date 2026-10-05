import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTargetFor, appSlug, slugify, SCRATCH_PATH } from '../simulator/device/paths.js';

test('apps run as a whole, other files on their own', () => {
  assert.deepEqual(runTargetFor('/apps/snake/game.py'), { kind: 'app', slug: 'snake', path: '/apps/snake' });
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
