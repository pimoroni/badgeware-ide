#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] || 'http://localhost:8000/index.html';
const screenshot = process.argv[3] || null;
const settleMs = Number(process.env.SETTLE_MS || 6000);
const script = process.env.EVAL || null;
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9340 + Math.floor(Math.random() * 50);

const browser = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bw-check-'))}`,
  '--window-size=1600,1000', '--no-first-run', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('Chrome did not start');
}

const socket = new WebSocket(await target());
await new Promise((resolve) => socket.addEventListener('open', resolve));
let nextId = 1;
const pending = new Map();
const problems = [];
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    problems.push(`exception: ${details.exception?.description ?? details.text}`);
  } else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
    problems.push(`console.${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ''}`);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
if (process.env.PRELOAD) await send('Page.addScriptToEvaluateOnNewDocument', { source: process.env.PRELOAD });
await send('Page.navigate', { url });
await sleep(settleMs);
if (script) {
  const result = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  console.log('eval:', JSON.stringify(result.result?.result?.value ?? result.result?.exceptionDetails?.text));
  await sleep(1000);
}
if (screenshot) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'));
}
console.log(problems.length ? problems.join('\n') : 'no console errors');
socket.close();
browser.kill();
process.exit(problems.some((p) => p.startsWith('exception')) ? 1 : 0);
