import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DebugClient } from '../simulator/device/debug.js';

const encode = (text) => new TextEncoder().encode(text);

test('recovers from a screen payload that stops short', async () => {
  const client = new DebugClient({});
  const events = [];
  client.addEventListener('message', ({ detail }) => events.push(detail));
  client.receive(encode('{"event": "screen", "id": "a", "width": 2, "height": 1, "bytes": 8}\n'));
  client.receive(new Uint8Array(5));
  await new Promise((resolve) => setTimeout(resolve, 1700));
  client.receive(encode('{"event": "continued"}\n'));
  assert.deepEqual(events.map((event) => [event.event, event.id]), [['error', 'a'], ['continued', undefined]]);
  await client.close().catch(() => {});
});
