import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateAvailable } from '../simulator/firmware.js';

test('offers updates only to badges on a release build', () => {
  const releases = { ide: [{ tag: 'v4.0.0-ide.2' }], stock: null };
  assert.equal(updateAvailable({ version: 'v4.0.0-ide.1' }, releases)?.tag, 'v4.0.0-ide.2');
  assert.equal(updateAvailable({ version: 'v4.0.0-ide.2' }, releases), null);
  assert.equal(updateAvailable({ version: 'v3.0.2-24-ge8a4066-dirty' }, releases), null);
  assert.equal(updateAvailable({ version: 'v4.0.0-ide.1-3-gabc1234' }, releases), null);
  assert.equal(updateAvailable({ version: 'unknown' }, releases), null);
  assert.equal(updateAvailable(null, releases), null);
  assert.equal(updateAvailable({ version: 'v4.0.0-ide.1' }, { ide: [], stock: null }), null);
});
