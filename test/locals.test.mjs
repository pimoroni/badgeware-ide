import { test } from 'node:test';
import assert from 'node:assert/strict';
import { functionFor, nameLocals } from '../simulator/locals.js';

const tables = {
  'badgeware/text.py': [
    { name: 'update', line: 74, n_state: 8, locals: ['text', 'font_face', null, 'target'] },
    { name: 'update', line: 120, n_state: 3, locals: ['other'] },
    { name: 'legacy', line: 200, locals: ['old'] },
  ],
};

test('finds a function by file, name and first line', () => {
  assert.equal(functionFor(tables, { file: 'badgeware/text.py', name: 'update', first: 120 }).locals[0], 'other');
  assert.equal(functionFor(tables, { file: 'badgeware/text.py', name: 'update', first: 75 }), null);
  assert.equal(functionFor(tables, { file: 'missing.py', name: 'update', first: 74 }), null);
  assert.equal(functionFor(null, { file: 'badgeware/text.py', name: 'update', first: 74 }), null);
});

test('maps physical slots to locals and hides stack temporaries', () => {
  const frame = { file: 'badgeware/text.py', name: 'update', first: 74 };
  const variables = [
    { name: 'local_07', value: '"hi"' },
    { name: 'local_06', value: '"font"' },
    { name: 'local_05', value: '1' },
    { name: 'local_04', value: '2' },
    { name: 'local_03', value: '3' },
    { name: 'local_01', value: '4' },
    { name: 'named', value: '5' },
  ];
  assert.deepEqual(nameLocals(variables, tables, frame).map((v) => [v.name, v.value]), [
    ['font_face', '"font"'],
    ['local_05', '1'],
    ['named', '5'],
    ['target', '2'],
    ['text', '"hi"'],
  ]);
});

test('leaves locals alone without a matching table or n_state', () => {
  const variables = [{ name: 'local_01', value: '1' }];
  assert.equal(nameLocals(variables, tables, { file: 'badgeware/text.py', name: 'update', first: 1 }), variables);
  assert.equal(nameLocals(variables, tables, { file: 'badgeware/text.py', name: 'legacy', first: 200 }), variables);
});
