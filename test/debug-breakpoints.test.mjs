import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakpointEntries, breakpointLines, breakpointOptions, hoverExpression } from '../simulator/debug-breakpoints.js';

test('breakpoints round-trip plain lines and options', () => {
  const entries = [3, { line: 7, condition: 'x > 2', hitCount: '>=5' }, { line: 9, logMessage: 'x is {x}' }];
  const lines = breakpointLines(entries);
  assert.equal(lines.get(3), null);
  assert.deepEqual(lines.get(7), { condition: 'x > 2', hitCount: '>=5' });
  assert.deepEqual(breakpointEntries(lines), entries);
});

test('breakpoint options keep only what is set', () => {
  assert.equal(breakpointOptions({ condition: ' ', hitCount: '', logMessage: '' }), null);
  assert.deepEqual(breakpointOptions({ condition: ' i == 3 ', hitCount: 10, logMessage: '' }), { condition: 'i == 3', hitCount: '10' });
});

test('hover picks the name or attribute under the cursor', () => {
  const line = '    total = self.offset + scale(width)';
  assert.deepEqual(hoverExpression(line, line.indexOf('offset') + 2), { text: 'self.offset', start: line.indexOf('self'), end: line.indexOf('offset') + 6 });
  assert.equal(hoverExpression(line, line.indexOf('self') + 1).text, 'self');
  assert.equal(hoverExpression(line, line.indexOf('width')).text, 'width');
  assert.equal(hoverExpression(line, line.indexOf('=')), null);
  assert.equal(hoverExpression('x = 12', 4), null);
});
