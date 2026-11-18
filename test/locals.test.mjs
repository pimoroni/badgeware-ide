import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localNamesFor, nameLocals } from '../simulator/locals.js';

const tables = {
  'badgeware/text.py': [
    { name: 'update', line: 74, locals: ['text', 'font_face', null, 'target'] },
    { name: 'update', line: 120, locals: ['other'] },
  ],
};

test('finds a function by file, name and first line', () => {
  assert.deepEqual(localNamesFor(tables, { file: 'badgeware/text.py', name: 'update', first: 120 }), ['other']);
  assert.equal(localNamesFor(tables, { file: 'badgeware/text.py', name: 'update', first: 75 }), null);
  assert.equal(localNamesFor(tables, { file: 'missing.py', name: 'update', first: 74 }), null);
  assert.equal(localNamesFor(null, { file: 'badgeware/text.py', name: 'update', first: 74 }), null);
});

test('renames placeholder locals and keeps unknown ones', () => {
  const frame = { file: 'badgeware/text.py', name: 'update', first: 74 };
  const variables = [
    { name: 'local_03', value: '1' },
    { name: 'local_00', value: '"hi"' },
    { name: 'local_02', value: '2' },
    { name: 'local_09', value: '3' },
    { name: 'named', value: '4' },
  ];
  assert.deepEqual(nameLocals(variables, tables, frame).map((v) => v.name), ['local_02', 'local_09', 'named', 'target', 'text']);
  assert.equal(nameLocals(variables, tables, { ...frame, first: 1 }), variables);
});
