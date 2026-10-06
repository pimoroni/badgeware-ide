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
const run = () => evaluate(`document.querySelector('#tab-controls [data-action="run"]').click()`);
const stop = () => evaluate(`document.querySelector('#tab-controls [data-action="stop"]').click()`);
const putWorkspace = (files) => evaluate(`(async () => {
  const { workspaceFS } = await import('./simulator/fs.js');
  await workspaceFS.ready;
  for (const [path, text] of ${JSON.stringify(files)}) workspaceFS.set(path, { text, binary: false });
  await workspaceFS.reload();
  return true;
})()`);
const badgeHas = (path) => evaluate(`(async () => {
  const { badgeFS } = await import('./simulator/device/session.js');
  await badgeFS.reload();
  return !!badgeFS.get(${JSON.stringify(path)});
})()`);
const contextAction = (tree, path, action) => evaluate(`(async () => {
  const el = [...document.querySelectorAll('#${tree} [data-path]')].find((e) => e.dataset.path === ${JSON.stringify(path)});
  if (!el) return 'no row for ${path}';
  (el.querySelector('summary') ?? el).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 200 }));
  const item = document.querySelector('#file-ctx-menu [data-action="${action}"]');
  if (item.style.display === 'none') return 'hidden ${action}';
  item.click();
  return true;
})()`);
const cleanBadge = () => evaluate(`(async () => {
  const { badgeDevice, badgeFS } = await import('./simulator/device/session.js');
  if (!badgeDevice?.connected) return false;
  for (const [path, size] of await badgeDevice.list('/apps')) {
    if (size < 0 && /\\/apps\\/e2e_[^/]+$/.test(path)) await badgeDevice.remove(path);
  }
  for (const [path] of await badgeDevice.list('/')) {
    if (/^\\/e2e_/.test(path)) await badgeDevice.remove(path);
  }
  await badgeFS.reload();
  return true;
})()`, 60000);

await open();
await evaluate(`localStorage.setItem('badgeware.target', 'badge')`);
await putWorkspace([
  ['/apps/e2e_error/__init__.py', ERROR_APP],
  ['/apps/e2e_debug/__init__.py', DEBUG_APP],
  ['/apps/e2e_sim/helper.py', 'def boom():\n    return 1 / 0\n'],
  ['/apps/e2e_sim/__init__.py', SIM_APP],
  ['/e2e_loose.py', 'print("loose")\n'],
]);
await evaluate(`localStorage.setItem('badgeware.breakpoints', JSON.stringify({ '/apps/e2e_debug/__init__.py': [9] }))`);

await open('?file=/apps/e2e_error/__init__.py');
check('badge target, editor nav active', await evaluate(`document.body.dataset.target === 'badge' && document.querySelector('#toolbar [data-action="editor"]').classList.contains('active')`));
check('no playground title', await evaluate(`!document.querySelector('.toolbar-title')`));
check('auto-connects to a paired badge', await waitFor(`document.body.classList.contains('badge-connected')`, 15000));
check('workspace on top, badge below', await waitFor(`document.getElementById('fp-user-list').textContent.includes('e2e_error') && document.getElementById('fp-sys-tree').textContent.includes('apps')`, 10000));
check('no simulator system tree', !(await evaluate(`document.getElementById('fp-sys-tree').textContent.includes('Read-only')`)));
await cleanBadge();

await run();
check('run syncs and ends with an error', await waitFor(`document.getElementById('status').textContent === 'Stopped (error)'`, 30000), `${await status()} / ${await stdout()}`);
check('synced to badge', (await stdout()).includes('Synced') && await badgeHas('/apps/e2e_error/__init__.py'));
check('error marker on line 5', (await evaluate(`monaco.editor.getModelMarkers({ owner: 'micropython' }).map((m) => [m.resource.path, m.startLineNumber])`))?.some(([path, line]) => path.includes('e2e_error') && line === 5));

await evaluate(`(() => { const editor = monaco.editor.getEditors()[0]; editor.setValue(editor.getValue().replace('missing_name', 'count')); })()`);
await run();
check('edit, sync and run', await waitFor(`document.getElementById('status').textContent === 'Running on badge…' && document.querySelector('#stdout > div').textContent.includes('\\n3\\n')`, 20000), `${await status()} / ${(await stdout()).slice(0, 200)}`);
await stop();
check('stop', await waitFor(`document.getElementById('status').textContent === 'Stopped'`, 10000), await status());

await open('?file=/apps/e2e_debug/__init__.py');
await waitFor(`document.body.classList.contains('badge-connected')`, 15000);
check('breakpoint decoration rendered', await waitFor(`!!document.querySelector('.debug-breakpoint')`, 10000));
await evaluate(`document.getElementById('debug-watch').querySelectorAll('li').length || (() => { const input = document.getElementById('debug-watch-add'); input.value = 'score * 2'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
await evaluate(`document.querySelector('#tab-controls [data-action="debug"]').click()`);
check('stopped at breakpoint', /\/apps\/e2e_debug\/__init__\.py:9/.test(await waitFor(`document.querySelector('#debug-stack li') && document.getElementById('debug-stack').textContent`, 30000) ?? ''), await stdout());
check('current line highlighted', await waitFor(`!!document.querySelector('.debug-current-line')`, 5000));
check('globals show score = 0', /score0/.test(await waitFor(`document.querySelector('#debug-globals .debug-vars') && document.getElementById('debug-globals').textContent`, 5000) ?? ''));
check('watch shows score * 2', await waitFor(`document.getElementById('debug-watch').textContent.includes('score * 20')`, 10000), await evaluate(`document.getElementById('debug-watch').textContent`));
check('screen shown on pause', await waitFor(`document.getElementById('debug-screen').classList.contains('ready')`, 10000));
await evaluate(`document.querySelector('#debug-controls [data-debug="continue"]').click()`);
check('continue stops again', await waitFor(`document.body.classList.contains('debug-paused') && document.getElementById('debug-globals').textContent.includes('score10')`, 10000));
for (const step of ['stepOver', 'stepIn', 'stepOver']) {
  const before = await status();
  await evaluate(`document.querySelector('#debug-controls [data-debug="${step}"]').click()`);
  await waitFor(`document.getElementById('status').textContent !== ${JSON.stringify(before)} && document.body.classList.contains('debug-paused') && document.querySelector('#debug-globals .debug-vars')`, 10000);
}
check('locals inside a function', (await waitFor(`!document.getElementById('debug-locals').hidden && document.getElementById('debug-locals').textContent`, 10000))?.includes("text'Score: 20'"));
await screenshot('e2e-badge-debug.png');
await evaluate(`document.querySelector('#debug-controls [data-action="stop"]').click()`);
check('stop ends the session', await waitFor(`!document.body.classList.contains('debugging') && document.getElementById('status').textContent === 'Stopped'`, 10000), await status());

await open('?file=/apps/e2e_error/__init__.py');
await waitFor(`document.body.classList.contains('badge-connected')`, 15000);
await evaluate(`document.querySelector('#tab-controls [data-action="debug"]').click()`);
check('debug a loop without breakpoints', await waitFor(`document.body.classList.contains('debugging') && document.getElementById('status').textContent === 'Debugging on badge…'`, 30000), await status());
await sleep(1500);
await evaluate(`document.querySelector('#debug-controls [data-debug="pause"]').click()`);
check('pause stops the loop', await waitFor(`document.body.classList.contains('debug-paused') && document.querySelector('#debug-globals .debug-vars')`, 10000), await status());
check('screen shown after pause', await waitFor(`document.getElementById('debug-screen').classList.contains('ready')`, 10000));
check('copy from the badge fails fast while paused', await contextAction('fp-sys-tree', '/apps/e2e_error', 'copy-to-workspace') === true && await waitFor(`document.getElementById('status').textContent.includes('busy running an app')`, 3000), await status());
await evaluate(`document.querySelector('#debug-controls [data-debug="continue"]').click()`);
check('continue after pause resumes', await waitFor(`!document.body.classList.contains('debug-paused') && document.getElementById('status').textContent === 'Debugging on badge…'`, 5000), await status());
await evaluate(`document.querySelector('#debug-controls [data-debug="pause"]').click()`);
await waitFor(`document.body.classList.contains('debug-paused')`, 10000);
await evaluate(`document.querySelector('#debug-controls [data-debug="continue"]').click()`);
check('quick pause and continue resumes', await waitFor(`!document.body.classList.contains('debug-paused') && document.getElementById('status').textContent === 'Debugging on badge…'`, 5000), await status());
await sleep(1000);
check('no stale pause state', await evaluate(`!document.body.classList.contains('debug-paused') && !document.querySelector('.debug-current-line')`));
await evaluate(`document.querySelector('#debug-controls [data-action="stop"]').click()`);
await waitFor(`!document.body.classList.contains('debugging')`, 10000);

await open();
await waitFor(`document.body.classList.contains('badge-connected')`, 15000);
await evaluate(`monaco.editor.getEditors()[0].setValue('x = 1\\nprint("scratch ok")\\nprint(y)\\n')`);
await run();
check('scratch run errors on line 3', await waitFor(`document.getElementById('status').textContent === 'Stopped (error)' && monaco.editor.getModelMarkers({ owner: 'micropython' }).some((m) => m.startLineNumber === 3)`, 20000), await stdout());

await evaluate(`monaco.editor.getEditors()[0].setValue('ticks = 0\\nwhile True:\\n    ticks += 1\\n    badge.update()\\n')`);
await evaluate(`document.querySelector('#tab-controls [data-action="debug"]').click()`);
await waitFor(`document.body.classList.contains('debugging') && document.getElementById('status').textContent === 'Debugging on badge…'`, 30000);
await sleep(1500);
await evaluate(`document.querySelector('#debug-controls [data-debug="pause"]').click()`);
check('scratch pause shows globals', await waitFor(`document.body.classList.contains('debug-paused') && document.getElementById('debug-globals').textContent.includes('ticks')`, 10000), await evaluate(`document.getElementById('debug-globals').textContent + ' / ' + document.getElementById('status').textContent`));
check('scratch pause shows screen', await waitFor(`document.getElementById('debug-screen').classList.contains('ready')`, 10000));
check('scratch pause marks the line', await waitFor(`!!document.querySelector('.debug-current-line')`, 5000));
await evaluate(`document.querySelector('#debug-controls [data-debug="continue"]').click()`);
check('scratch continue resumes', await waitFor(`!document.body.classList.contains('debug-paused')`, 5000), await status());
await evaluate(`document.querySelector('#debug-controls [data-action="stop"]').click()`);
await waitFor(`!document.body.classList.contains('debugging')`, 10000);

await evaluate(`(async () => {
  document.querySelector('#fp-user [data-action="new-app"]').click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const input = document.querySelector('#new-app-dialog [name="name"]');
  input.value = 'E2E Rocket';
  input.dispatchEvent(new Event('input'));
  document.querySelector('#new-app-dialog button[value="create"]').click();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  document.querySelector('#icon-editor [data-icon="save"]').click();
  return true;
})()`);
check('new app in the workspace', await waitFor(`(async () => { const { workspaceFS } = await import('./simulator/fs.js'); return !!workspaceFS.get('/apps/e2e_rocket/icon.png'); })()`, 5000));
await run();
check('new app runs on badge', await waitFor(`document.getElementById('status').textContent === 'Running on badge…'`, 20000), await stdout());
await stop();
await waitFor(`document.getElementById('status').textContent === 'Stopped'`, 10000);
check('new app is on the badge', await badgeHas('/apps/e2e_rocket/icon.png'));

check('copy to badge from workspace', await contextAction('fp-user-list', '/e2e_loose.py', 'copy-to-badge') === true && await waitFor(`(async () => { const { badgeFS } = await import('./simulator/device/session.js'); await badgeFS.reload(); return !!badgeFS.get('/e2e_loose.py'); })()`, 15000));
await evaluate(`(async () => { const { workspaceFS } = await import('./simulator/fs.js'); workspaceFS.del('/apps/e2e_rocket/__init__.py'); workspaceFS.del('/apps/e2e_rocket/icon.png'); workspaceFS.del('/apps/e2e_rocket/'); return true; })()`);
await evaluate(`(async () => { const { badgeFS } = await import('./simulator/device/session.js'); await badgeFS.reload(); document.querySelector('[data-action="badge-refresh"]').click(); return true; })()`);
await sleep(1000);
check('copy to workspace from badge', await contextAction('fp-sys-tree', '/apps/e2e_rocket', 'copy-to-workspace') === true && await waitFor(`(async () => { const { workspaceFS } = await import('./simulator/fs.js'); return !!workspaceFS.get('/apps/e2e_rocket/icon.png') && !!workspaceFS.get('/apps/e2e_rocket/__init__.py'); })()`, 15000));
await evaluate(`(() => { const row = [...document.querySelectorAll('#fp-sys-tree .tree-row')].find((el) => el.dataset.path === '/apps/e2e_error/__init__.py'); row.click(); return true; })()`);
check('badge file opens read-only', await waitFor(`document.getElementById('status').textContent.includes('on your badge, read-only') && monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.readOnly)`, 10000), await status());
check('rom is read-only in the badge tree', await evaluate(`(() => {
  const el = [...document.querySelectorAll('#fp-sys-tree [data-path]')].find((e) => e.dataset.path === '/rom/fonts');
  (el.querySelector('summary') ?? el).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 200 }));
  const hidden = (action) => document.querySelector('#file-ctx-menu [data-action="' + action + '"]').style.display === 'none';
  const result = hidden('copy-to-workspace') && hidden('delete');
  document.body.click();
  return result;
})()`));
await evaluate(`window.confirm = () => true`);
check('delete on badge', await contextAction('fp-sys-tree', '/e2e_loose.py', 'delete') === true && await waitFor(`(async () => { const { badgeFS } = await import('./simulator/device/session.js'); await badgeFS.reload(); return !badgeFS.get('/e2e_loose.py'); })()`, 15000));

const originalSecrets = await evaluate(`(async () => {
  const { badgeFS } = await import('./simulator/device/session.js');
  if (!badgeFS.get('/secrets.py')) return null;
  return (await badgeFS.load('/secrets.py')).text;
})()`);
await evaluate(`document.querySelector('[data-action="config"]').click()`);
check('config loads from the badge', await waitFor(`!document.querySelector('#config form').hidden && document.querySelector('#config [name=region]').value !== ''`, 10000));
await evaluate(`(() => {
  const form = document.querySelector('#config form');
  form.elements.wifi_ssid.value = 'E2E Net';
  document.querySelector('[data-config="add"]').click();
  const row = document.querySelector('.config-custom li:last-child');
  row.querySelector('.config-key').value = 'GITHUB_USERNAME';
  row.querySelector('.config-value').value = 'octocat';
  form.requestSubmit();
})()`);
check('config saves to the badge', await waitFor(`document.getElementById('status').textContent.includes('Saved settings to your badge')`, 15000), await status());
const savedSecrets = await evaluate(`(async () => { const { badgeDevice } = await import('./simulator/device/session.js'); return new TextDecoder().decode(await badgeDevice.read('/secrets.py')); })()`);
check('secrets.py on the badge', savedSecrets.includes('GITHUB_USERNAME = "octocat"') && savedSecrets.includes('WIFI_SSID = "E2E Net"'), savedSecrets);
await evaluate(`(async () => {
  const { badgeDevice, badgeFS } = await import('./simulator/device/session.js');
  const original = ${JSON.stringify(originalSecrets)};
  if (original === null) await badgeDevice.remove('/secrets.py');
  else await badgeDevice.write('/secrets.py', new TextEncoder().encode(original));
  await badgeFS.reload();
  return true;
})()`);
await evaluate(`document.querySelector('[data-action="config"]').click()`);

check('cleans up the badge', await cleanBadge());
await evaluate(`document.querySelector('#target-switch [data-target="simulator"]').click()`);
check('switches to the simulator in place', await waitFor(`document.body.dataset.target === 'simulator' && getComputedStyle(document.getElementById('simulator')).display !== 'none'`, 10000));
check('config disabled for the simulator', await evaluate(`document.querySelector('[data-action="config"]').disabled`));
await open('?file=/apps/e2e_sim/__init__.py');
await sleep(2000);
await run();
check('simulator launches the app', await waitFor(`document.getElementById('status').textContent === 'Stopped (error)' && document.querySelector('#stdout > div').textContent.includes('/apps/e2e_sim/helper.py')`, 30000), await stdout());
check('simulator marks the app file', (await evaluate(`monaco.editor.getModelMarkers({ owner: 'micropython' }).map((m) => m.startLineNumber)`))?.includes(4));
await evaluate(`localStorage.setItem('badgeware.target', 'badge')`);
check('no page exceptions', exceptions.length === 0, exceptions.join('\n'));

socket.close();
browser.kill();
console.log(`${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
