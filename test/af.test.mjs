import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afParse, afMeasure } from '../simulator/af.js';

const fonts = new URL('../simulator/boards/blinky/filesystem/rom/fonts/', import.meta.url);
const parse = (name) => afParse(new Uint8Array(readFileSync(new URL(name, fonts))).buffer);

test('parses a narrow font', () => {
  const font = parse('lexend.af');
  assert.equal(font.wide, false);
  assert.equal(font.unitsPerEm, 128);
  assert.equal(font.glyphCount, 287);
  assert.equal(font.pointCount, font.glyphs.reduce((sum, glyph) => sum + glyph.paths.reduce((n, path) => n + path.pc, 0), 0));
});

test('parses a wide font with its own em', () => {
  const font = parse('dseg7.af');
  assert.equal(font.wide, true);
  assert.ok(font.unitsPerEm > 128);
  assert.equal(font.pointCount, font.glyphs.reduce((sum, glyph) => sum + glyph.paths.reduce((n, path) => n + path.pc, 0), 0));
  const eight = font.glyphs[font.cpMap.get('8'.codePointAt(0))];
  assert.ok(eight.paths.length > 0 && eight.w > 0 && eight.w <= font.unitsPerEm);
  assert.ok(afMeasure(font, '88', 20) > 0 && afMeasure(font, '88', 20) < 60);
});
