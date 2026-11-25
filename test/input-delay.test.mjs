import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserDelays } from '../simulator/input-delay.js';

const key = (startTime, wait) => ({ name: 'keydown', startTime, processingStart: startTime + wait });

test('counts keystrokes held back outside the page', () => {
  const events = [key(1000, 180), key(2000, 8), key(3000, 150), { name: 'pointermove', startTime: 4000, processingStart: 4300 }];
  assert.deepEqual(browserDelays(events, []).map((event) => event.startTime), [1000, 3000]);
});

test('ignores waits a long task in the page explains', () => {
  const events = [key(1000, 180), key(3000, 150)];
  const longTasks = [{ startTime: 990, duration: 200 }];
  assert.deepEqual(browserDelays(events, longTasks).map((event) => event.startTime), [3000]);
});
