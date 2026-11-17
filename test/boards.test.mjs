import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { activeBoardId, appliesTo, boardForModel, boardForProductId, getBoard, setActiveBoard } from '../simulator/boards.js';
import { BADGE_FILTERS, SUPPORTED_MODELS } from '../simulator/device/badge.js';
import { completionsFor } from '../simulator/completions.js';
import { einkPixels, ledLevels, EINK_PALETTE } from '../simulator/screens.js';
import { boardForIdent, releasesFor } from '../simulator/firmware.js';

const labels = (entries) => entries.map((entry) => entry.label);

function withStorage(fn) {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  try {
    fn();
  } finally {
    delete globalThis.localStorage;
  }
}

test('boards are found from the badge ident and USB product id', () => {
  assert.equal(boardForModel('tufty2350').id, 'tufty');
  assert.equal(boardForModel('badger2350').id, 'badger');
  assert.equal(boardForModel('blinky2350').id, 'blinky');
  assert.equal(boardForModel('presto'), null);
  assert.equal(boardForProductId(0x1100).id, 'badger');
  assert.equal(boardForProductId(0x1234), null);
  assert.equal(getBoard('nope').id, 'tufty');
  assert.deepEqual(BADGE_FILTERS.map((filter) => filter.usbProductId), [0x1100, 0x1101, 0x1102]);
  assert.deepEqual(Object.keys(SUPPORTED_MODELS).sort(), ['badger2350', 'blinky2350', 'tufty2350']);
});

test('the active board is stored, defaulting to Tufty', () => {
  assert.equal(activeBoardId(), 'tufty');
  withStorage(() => {
    assert.equal(activeBoardId(), 'tufty');
    setActiveBoard('blinky');
    assert.equal(activeBoardId(), 'blinky');
    setActiveBoard('nope');
    assert.equal(activeBoardId(), 'blinky');
  });
});

test('only Tufty keeps the original workspace store', () => {
  assert.equal(getBoard('tufty').userStore, 'badgeware.userfs');
  assert.equal(new Set(['tufty', 'badger', 'blinky'].map((id) => getBoard(id).userStore)).size, 3);
});

test('entries without boards apply everywhere', () => {
  assert.equal(appliesTo({}, 'badger'), true);
  assert.equal(appliesTo({ boards: ['tufty'] }, 'badger'), false);
  assert.equal(appliesTo({ boards: ['tufty', 'badger'] }, 'badger'), true);
});

test('completions share a common set and diverge per board', () => {
  const tufty = completionsFor('tufty');
  const badger = completionsFor('badger');
  const blinky = completionsFor('blinky');
  for (const set of [tufty, badger, blinky]) {
    assert.ok(labels(set.globals).includes('BUTTON_A'));
    assert.ok(labels(set.members.badge).includes('caselights'));
    assert.equal(new Set(labels(set.globals)).size, set.globals.length);
  }
  assert.ok(labels(tufty.globals).includes('HIRES'));
  assert.ok(!labels(tufty.globals).includes('FAST_UPDATE'));
  assert.ok(labels(badger.globals).includes('FAST_UPDATE'));
  assert.ok(labels(badger.globals).includes('wait_for_button_or_alarm'));
  assert.ok(!labels(badger.globals).includes('HIRES'));
  assert.ok(labels(blinky.globals).includes('SS_X4'));
  assert.ok(!labels(blinky.globals).includes('NON_BLOCKING'));
  assert.ok(labels(tufty.members.display).includes('backlight'));
  assert.deepEqual(labels(badger.members.display).filter((label) => ['busy', 'speed', 'backlight'].includes(label)), ['speed', 'busy']);
  assert.ok(labels(blinky.members.display).includes('SCALE'));
  assert.ok(labels(tufty.members.badge).includes('light_level'));
  assert.ok(!labels(badger.members.badge).includes('light_level'));
  const width = (set) => set.members.screen.find((entry) => entry.label === 'width').doc;
  assert.match(width(tufty), /320/);
  assert.match(width(badger), /264/);
  assert.match(width(blinky), /39/);
});

test('e-ink frames quantise to four greys', () => {
  const frame = { buffer: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]).buffer, width: 2, height: 1 };
  const pixels = einkPixels(frame);
  assert.deepEqual([...pixels.slice(0, 3)], EINK_PALETTE[0]);
  assert.deepEqual([...pixels.slice(4, 7)], EINK_PALETTE[3]);
});

test('LED levels skip dark and missing LEDs', () => {
  const width = 39, height = 26;
  const data = new Uint8Array(width * height * 4).fill(255);
  const levels = ledLevels({ buffer: data.buffer, width, height }, width, height);
  assert.ok(levels.length > 800 && levels.length < width * height);
  assert.ok(!levels.some(({ col, row }) => row === 25 && col === 0));
  assert.equal(ledLevels({ buffer: new Uint8Array(width * height * 4).buffer, width, height }, width, height).length, 0);
});

test('firmware releases and flash layout come from the board', () => {
  const manifest = { boards: { tufty2350: { ide: [{ tag: 'v4.0.0-ide.1' }], stock: null } } };
  assert.equal(releasesFor(manifest, getBoard('tufty')).ide[0].tag, 'v4.0.0-ide.1');
  assert.deepEqual(releasesFor(manifest, getBoard('badger')), { ide: [], stock: null });
  assert.deepEqual(releasesFor(null, getBoard('blinky')), { ide: [], stock: null });
  assert.equal(boardForIdent({ model: 'blinky2350' }).id, 'blinky');
  assert.equal(boardForIdent(null, 0x1100).id, 'badger');
  assert.equal(boardForIdent(null).id, 'tufty');
  assert.equal(getBoard('badger').firmware.filesystemBase, 0x10300000);
});

test('the bundle tool maps firmware paths to the flat layout', () => {
  const script = [
    'import json, sys',
    'sys.path.insert(0, "tools")',
    'from bundle_board import destination, rewrite',
    'paths = ["firmware/apps/menu/__init__.py", "firmware/fonts/a.af", "firmware/assets/x.png", "modules/common/badgeware/badge.py", "romfs/fonts/sins.ppf", "board/pins.csv"]',
    'print(json.dumps({"paths": [destination(path) for path in paths], "rewrite": rewrite("__import__(\\".frozen/badgeware/badge\\")")}))',
  ].join('\n');
  const result = JSON.parse(execFileSync('python3', ['-c', script], { cwd: new URL('..', import.meta.url) }).toString());
  assert.deepEqual(result.paths, ['apps/menu/__init__.py', 'fonts/a.af', 'assets/x.png', 'badgeware/badge.py', 'rom/fonts/sins.ppf', null]);
  assert.equal(result.rewrite, '__import__("badgeware/badge")');
});
