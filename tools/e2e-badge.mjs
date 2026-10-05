#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [replPort, debugPort] = (process.env.BADGE_PORTS || '').split(',');
if (!replPort || !debugPort) {
  console.error('Set BADGE_PORTS=<repl>,<debug>');
  process.exit(2);
}
const base = process.env.IDE_URL || 'http://localhost:8123/index.html';
const bridgeUrl = process.env.BRIDGE_URL || 'ws://localhost:8765';
const shots = process.env.SHOTS || tmpdir();
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cdpPort = 9400 + Math.floor(Math.random() * 50);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition || !detail ? '' : ` (${detail})`}`);
  if (!condition) failures.push(name);
};

const browser = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bw-e2e-'))}`,
  '--window-size=1600,1000', '--no-first-run', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => browser.kill());

let socketUrl;
for (let i = 0; i < 50 && !socketUrl; i++) {
  try {
    socketUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((p) => p.type === 'page')?.webSocketDebuggerUrl;
  } catch (_) {}
  await sleep(100);
}
const socket = new WebSocket(socketUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve));
let nextId = 1;
const pending = new Map();
const exceptions = [];
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, timeout = 30000) => {
  const reply = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    sleep(timeout).then(() => { throw new Error(`evaluate timed out: ${expression.slice(0, 80)}`); }),
  ]);
  if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text);
  return reply.result?.result?.value;
};
const waitFor = async (expression, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(expression).catch(() => null);
    if (value) return value;
    await sleep(200);
  }
  return null;
};
const screenshot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(shot.result.data, 'base64'));
};
const open = async (query = '') => {
  await send('Page.navigate', { url: base + (query.startsWith('?') ? query : '?' + query) });
  await waitFor(`!!document.querySelector('#editor .monaco-editor') && !!document.querySelector('#tab-bar li')`);
  await sleep(500);
};

await send('Runtime.enable');
await send('Page.enable');
const shim = readFileSync(new URL('../test/web-serial-shim.js', import.meta.url), 'utf8');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__BADGE_BRIDGE__ = ${JSON.stringify({ url: bridgeUrl, ports: [debugPort, replPort] })};\n${shim}`,
});

const ERROR_APP = 'count = 0\n\nwhile True:\n    count += 1\n    print(missing_name)\n    badge.update()\n';
const DEBUG_APP = 'score = 0\nnames = ["a", "b"]\n\ndef label_for(value):\n    text = "Score: " + str(value)\n    return text\n\nwhile True:\n    score += 10\n    screen.text(label_for(score), 10, 10)\n    if score >= 50:\n        break\n    badge.update()\n';
const SIM_APP = 'from helper import boom\n\nbadge.update()\nboom()\n';

const status = () => evaluate(`document.getElementById('status').textContent`);
const stdout = () => evaluate(`document.querySelector('#stdout > div').textContent`);
const putBadgeFiles = (files) => evaluate(`(async () => {
  const { userFS } = await import('./simulator/fs.js');
  const { badgeFS } = await import('./simulator/device/session.js');
  for (const [path, text] of ${JSON.stringify(files)}) userFS.set(path, { text, binary: false });
  await badgeFS.flush();
  return true;
})()`);

const cleanBadge = () => evaluate(`(async () => {
  const { badgeDevice, badgeFS } = await import('./simulator/device/session.js');
  if (!badgeDevice?.connected) return false;
  const apps = await badgeDevice.list('/system/apps');
  for (const [path, size] of apps) {
    if (size < 0 && /\\/system\\/apps\\/e2e_[^/]+$/.test(path)) await badgeDevice.remove(path);
  }
  await badgeFS.reload();
  return true;
})()`, 60000);

await open('?mode=badge');
check('badge mode is active', await evaluate(`document.body.dataset.mode`) === 'badge');
check('auto-connects to a paired badge', await waitFor(`document.body.classList.contains('badge-connected')`, 15000));
check('connection shows the board', (await evaluate(`document.getElementById('connect-badge').textContent`)).includes('Tufty 2350'));
await cleanBadge();
check('files panel lists the badge', await waitFor(`document.getElementById('fp-user-list').textContent.includes('menu')`, 10000));
check('no 3D view in badge mode', await evaluate(`getComputedStyle(document.getElementById('simulator')).display`) === 'none');
check('debug panel idle hint', await evaluate(`getComputedStyle(document.getElementById('debug-idle')).display !== 'none'`));

await putBadgeFiles([
  ['/system/apps/e2e_error/__init__.py', ERROR_APP],
  ['/system/apps/e2e_debug/__init__.py', DEBUG_APP],
]);
await evaluate(`localStorage.setItem('badgeware.breakpoints', JSON.stringify({ '/system/apps/e2e_debug/__init__.py': [9] }))`);

await open('?mode=badge&file=/system/apps/e2e_error/__init__.py');
check('opens a badge file', await waitFor(`monaco.editor.getEditors()[0].getValue().includes('missing_name')`, 15000));
await evaluate(`document.querySelector('#tab-controls [data-action="run"]').click()`);
check('run ends with an error', await waitFor(`document.getElementById('status').textContent === 'Stopped (error)'`, 30000), `${await status()} / ${await stdout()}`);
const markers = await evaluate(`monaco.editor.getModelMarkers({ owner: 'micropython' }).map((m) => m.startLineNumber)`);
check('error marker on line 5', markers?.includes(5), JSON.stringify(markers));

await evaluate(`(() => { const editor = monaco.editor.getEditors()[0]; editor.setValue(editor.getValue().replace('missing_name', 'count')); })()`);
await evaluate(`document.querySelector('#tab-controls [data-action="run"]').click()`);
check('edited file saves to the badge and runs', await waitFor(`document.getElementById('status').textContent === 'Running on badge…' && document.querySelector('#stdout > div').textContent.includes('\\n3\\n')`, 20000), `${await status()} / ${(await stdout()).slice(0, 200)}`);
await evaluate(`document.querySelector('#tab-controls [data-action="stop"]').click()`);
check('stop', await waitFor(`document.getElementById('status').textContent === 'Stopped'`, 10000), await status());

await open('?mode=badge&file=/system/apps/e2e_debug/__init__.py');
check('breakpoint decoration rendered', await waitFor(`!!document.querySelector('.debug-breakpoint')`, 10000));
await evaluate(`document.querySelector('#tab-controls [data-action="debug"]').click()`);
const stack = await waitFor(`document.querySelector('#debug-stack li') && document.getElementById('debug-stack').textContent`, 30000);
check('stopped at breakpoint', /\/system\/apps\/e2e_debug\/__init__\.py:9/.test(stack ?? ''), stack ?? await stdout());
check('current line highlighted', await waitFor(`!!document.querySelector('.debug-current-line')`, 5000));
check('globals show score = 0', /score0/.test(await waitFor(`document.querySelector('#debug-globals .debug-vars') && document.getElementById('debug-globals').textContent`, 5000) ?? ''));
await evaluate(`(() => { const input = document.getElementById('debug-eval'); input.value = 'score + 5'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
check('eval result', await waitFor(`document.querySelector('.debug-eval-result')?.textContent === '5'`, 5000));
await screenshot('e2e-badge-debug.png');
await evaluate(`document.querySelector('#debug-controls [data-debug="continue"]').click()`);
check('continue stops again with score = 10', await waitFor(`document.body.classList.contains('debug-paused') && document.getElementById('debug-globals').textContent.includes('score10')`, 10000));
check('no locals section at module level', await evaluate(`document.getElementById('debug-locals').hidden`));
for (const step of ['stepOver', 'stepIn', 'stepOver']) {
  const before = await status();
  await evaluate(`document.querySelector('#debug-controls [data-debug="${step}"]').click()`);
  await waitFor(`document.getElementById('status').textContent !== ${JSON.stringify(before)} && document.body.classList.contains('debug-paused') && document.querySelector('#debug-globals .debug-vars')`, 10000);
}
const locals = await waitFor(`!document.getElementById('debug-locals').hidden && document.getElementById('debug-locals').textContent`, 10000);
check('locals inside a function', locals?.includes("text'Score: 20'") && locals?.includes('value20'), locals);
check('stack shows the function', /label_for/.test(await evaluate(`document.getElementById('debug-stack').textContent`)));
await screenshot('e2e-badge-locals.png');
await evaluate(`document.querySelector('#debug-controls [data-action="stop"]').click()`);
check('stop ends the session', await waitFor(`!document.body.classList.contains('debugging') && document.getElementById('status').textContent === 'Stopped'`, 10000), await status());

await open('?mode=badge');
await evaluate(`monaco.editor.getEditors()[0].setValue('x = 1\\nprint("scratch ok")\\nprint(y)\\n')`);
await evaluate(`document.querySelector('#tab-controls [data-action="run"]').click()`);
check('scratch run errors on line 3', await waitFor(`document.getElementById('status').textContent === 'Stopped (error)' && monaco.editor.getModelMarkers({ owner: 'micropython' }).some((m) => m.startLineNumber === 3)`, 20000), await stdout());

await evaluate(`(async () => {
  window.prompt = () => 'E2E Rocket';
  document.querySelector('#fp-user [data-action="new-app"]').click();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  document.querySelector('#icon-editor [data-icon="save"]').click();
  return true;
})()`);
check('new app created on the badge', await waitFor(`(async () => { const { badgeFS } = await import('./simulator/device/session.js'); await badgeFS.flush(); await badgeFS.reload(); return !!badgeFS.get('/system/apps/e2e_rocket/icon.png') && !!badgeFS.get('/system/apps/e2e_rocket/__init__.py'); })()`, 10000));
await evaluate(`document.querySelector('#tab-controls [data-action="run"]').click()`);
check('new app runs on badge', await waitFor(`document.getElementById('status').textContent === 'Running on badge…'`, 20000), await stdout());
await sleep(1000);
await evaluate(`document.querySelector('#tab-controls [data-action="stop"]').click()`);
check('new app stops', await waitFor(`document.getElementById('status').textContent === 'Stopped'`, 10000), await status());

check('rename on the badge', await evaluate(`(async () => {
  const { userFS } = await import('./simulator/fs.js');
  const { badgeFS } = await import('./simulator/device/session.js');
  await userFS.rename('/system/apps/e2e_debug', '/system/apps/e2e_renamed');
  await badgeFS.reload();
  return !!badgeFS.get('/system/apps/e2e_renamed/__init__.py') && !badgeFS.get('/system/apps/e2e_debug/__init__.py');
})()`));

check('copy to simulator', await evaluate(`(async () => {
  const { workspaceFS } = await import('./simulator/fs.js');
  const row = [...document.querySelectorAll('#fp-user-list [data-path]')].find((el) => el.dataset.path === '/system/apps/e2e_rocket');
  if (!row) return 'no row: ' + [...document.querySelectorAll('#fp-user-list [data-path]')].map((el) => el.dataset.path).filter((p) => p.includes('e2e')).join(',');
  (row.querySelector('summary') ?? row).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 200 }));
  document.querySelector('#file-ctx-menu [data-action="copy-to-simulator"]').click();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return !!workspaceFS.get('/apps/e2e_rocket/icon.png') && !!workspaceFS.get('/apps/e2e_rocket/__init__.py') || 'missing: ' + workspaceFS.paths().join(',') + ' / ' + document.getElementById('status').textContent;
})()`).then((r) => { if (r !== true) console.log('   ', r); return r; }) === true);

await evaluate(`(async () => {
  const { workspaceFS } = await import('./simulator/fs.js');
  workspaceFS.set('/apps/e2e_sim/helper.py', { text: 'def boom():\\n    return 1 / 0\\n', binary: false });
  workspaceFS.set('/apps/e2e_sim/__init__.py', { text: ${JSON.stringify(SIM_APP)}, binary: false });
  return true;
})()`);
await evaluate(`document.querySelector('[data-action="copy-from-simulator"]').click()`);
await waitFor(`document.getElementById('copy-dialog').open`, 5000);
await evaluate(`(() => {
  const dialog = document.getElementById('copy-dialog');
  dialog.querySelectorAll('input').forEach((box) => { box.checked = box.value === '/apps/e2e_sim'; });
  dialog.querySelector('button[value="copy"]').click();
})()`);
check('copy from simulator', await waitFor(`(async () => { const { badgeFS } = await import('./simulator/device/session.js'); return !!badgeFS.get('/system/apps/e2e_sim/helper.py'); })()`, 15000));

const originalSecrets = await evaluate(`(async () => {
  const { badgeFS } = await import('./simulator/device/session.js');
  if (!badgeFS.get('/secrets.py')) return null;
  return (await badgeFS.load('/secrets.py')).text;
})()`);
await open('?mode=badge');
await evaluate(`document.querySelector('[data-action="config"]').click()`);
check('config pane loads settings', await waitFor(`!document.querySelector('#config form').hidden && document.querySelector('#config [name=region]').value !== ''`, 10000));
await evaluate(`(() => {
  const form = document.querySelector('#config form');
  form.elements.wifi_ssid.value = 'E2E "Net"';
  form.elements.wifi_password.value = 'p\\\\ss';
  form.elements.timezone.value = '5.5';
  document.querySelector('[data-config="add"]').click();
  const row = document.querySelector('.config-custom li:last-child');
  row.querySelector('.config-key').value = 'GITHUB_USERNAME';
  row.querySelector('.config-value').value = 'octocat';
  form.requestSubmit();
})()`);
check('config saves', await waitFor(`document.getElementById('status').textContent.includes('Saved settings to your badge')`, 15000), await status());
const savedSecrets = await evaluate(`(async () => {
  const { badgeDevice } = await import('./simulator/device/session.js');
  return new TextDecoder().decode(await badgeDevice.read('/secrets.py'));
})()`);
check('secrets.py written to the badge', savedSecrets.includes('WIFI_SSID = "E2E \\"Net\\""') && savedSecrets.includes('GITHUB_USERNAME = "octocat"') && savedSecrets.includes('TIMEZONE = 5.5'), savedSecrets);
await evaluate(`document.querySelector('[data-action="config"]').click()`);
await evaluate(`monaco.editor.getEditors()[0].setValue('import secrets\\nprint(secrets.GITHUB_USERNAME, secrets.WIFI_SSID, secrets.WIFI_PASSWORD, secrets.TIMEZONE)\\n')`);
await evaluate(`document.querySelector('#tab-controls [data-action="run"]').click()`);
check('badge reads the new secrets', await waitFor(`document.querySelector('#stdout > div').textContent.includes('octocat E2E "Net" p\\\\ss 5.5')`, 20000), await stdout());
await evaluate(`(async () => {
  const { badgeDevice, badgeFS } = await import('./simulator/device/session.js');
  const original = ${JSON.stringify(originalSecrets)};
  if (original === null) await badgeDevice.remove('/secrets.py');
  else await badgeDevice.write('/secrets.py', new TextEncoder().encode(original));
  await badgeFS.reload();
  return true;
})()`);
check('cleans up the badge', await cleanBadge());
await evaluate(`document.querySelector('#toolbar [data-action="editor"][data-mode="simulator"]').click()`);
check('switches to simulator mode', await waitFor(`document.body.dataset.mode === 'simulator' && location.search.includes('mode=simulator')`, 15000));
await open('?mode=simulator&file=/apps/e2e_sim/__init__.py');
check('3D view in simulator mode', await evaluate(`getComputedStyle(document.getElementById('simulator')).display`) !== 'none');
await evaluate(`document.querySelector('#tab-controls [data-action="run"]').click()`);
check('simulator launches the app', await waitFor(`document.getElementById('status').textContent === 'Stopped (error)' && document.querySelector('#stdout > div').textContent.includes('/apps/e2e_sim/helper.py')`, 30000), await stdout());
check('simulator marks the app file', (await evaluate(`monaco.editor.getModelMarkers({ owner: 'micropython' }).map((m) => m.startLineNumber)`))?.includes(4));
check('no page exceptions', exceptions.length === 0, exceptions.join('\n'));

socket.close();
browser.kill();
console.log(`${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
