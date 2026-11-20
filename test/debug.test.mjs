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

test('badge commands fail fast while an app is running', async () => {
  const { BadgeDevice, BadgeBusyError } = await import('../simulator/device/badge.js');
  const { ReplTransport } = await import('../simulator/device/repl-transport.js');
  const badge = new BadgeDevice({ serial: {} });
  badge.transport = new ReplTransport({ device: badge, repl: {} });
  badge.transport.running = true;
  await assert.rejects(badge.read('/apps/tennis/__init__.py'), BadgeBusyError);
});

test('screen pixels pass RGBA through and expand RGB565', async () => {
  const { screenPixels } = await import('../simulator/device/debug.js');
  const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual([...screenPixels({ width: 2, height: 1, payload: rgba })], [...rgba]);
  assert.deepEqual([...screenPixels({ width: 2, height: 1, format: 'RGBA8888', payload: rgba })], [...rgba]);
  const rgb565 = new Uint8Array([0x00, 0xf8, 0xe0, 0x07]);
  assert.deepEqual([...screenPixels({ width: 2, height: 1, format: 'RGB565', payload: rgb565 })], [255, 0, 0, 255, 0, 255, 0, 255]);
});
