import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fontUsage } from '../simulator/font-snippet.js';

const loadOf = (path) => fontUsage(path).split('\n')[0];

test('ROM fonts load by attribute, vector or pixel', () => {
  assert.equal(loadOf('/rom/fonts/sins.ppf'), 'screen.font = font.sins');
  assert.equal(loadOf('/rom/fonts/lexend.af'), 'screen.font = font.lexend');
});

test('other fonts load by search name or path', () => {
  assert.equal(loadOf('/fonts/custom.af'), 'screen.font = font.load("custom")');
  assert.equal(loadOf('/apps/a/thing.ppf'), 'screen.font = font.load("/apps/a/thing.ppf")');
  assert.equal(fontUsage('/apps/a/readme.txt'), null);
});
