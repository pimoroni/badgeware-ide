import { IncompatibleBadgeError, MissingReplError } from './device/badge.js';
import { runTargetFor, SCRATCH_PATH } from './device/paths.js';
import { workspaceFS } from './fs.js';

function lineSplitter(onLine) {
  let pending = '';
  return {
    push(text) {
      pending += text.replace(/\r/g, '');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    },
    flush() {
      if (pending) onLine(pending);
      pending = '';
    },
  };
}

const fileBytes = (entry) => (entry.binary ? entry.data : new TextEncoder().encode(entry.text));

const NEVER_SYNC = new Set(['/secrets.py']);

function workspaceFiles() {
  return workspaceFS.paths()
    .filter((path) => !path.endsWith('/') && !NEVER_SYNC.has(path))
    .map((path) => [path, workspaceFS.get(path)])
    .filter(([, entry]) => entry && !entry.isDir)
    .map(([path, entry]) => ({ path, bytes: fileBytes(entry) }));
}

const PAIR_MESSAGES = {
  first: ['Connect your badge', 'Your badge shows up twice in the list, because it has two connections: one for code and one for the debugger. Pick either one. If Chrome only grants that one, the IDE will ask for the other next.'],
  repl: ['One more port', 'That was the debugger connection. Pick the other entry for your badge so the IDE can run your code.'],
  debug: ['Enable debugging', 'To debug, the IDE also needs your badge\'s second connection. Pick the entry you didn\'t choose before.'],
};

export function createBadgeTarget(els, { device, badgeFS, output, setStatus, flashStatus, debuggerHooks, autoConnect = true }) {
  let runningPath = null;

  function askToPair(kind) {
    const [title, text] = PAIR_MESSAGES[kind];
    els.pairDialog.querySelector('h2').textContent = title;
    els.pairDialog.querySelector('.pair-text').textContent = text;
    els.pairDialog.returnValue = '';
    els.pairDialog.showModal();
    return new Promise((resolve) => {
      els.pairDialog.addEventListener('close', async () => {
        if (els.pairDialog.returnValue !== 'choose') return resolve(false);
        try {
          await device.requestPort();
          resolve(true);
        } catch (_) {
          resolve(false);
        }
      }, { once: true });
    });
  }

  function render() {
    const connected = device.connected;
    els.connect.classList.toggle('connected', connected);
    els.connect.title = connected ? `Connected to ${device.ident?.board ?? 'badge'}. Click to disconnect.` : 'Connect your badge';
    els.connectLabel.textContent = connected ? (device.ident?.board?.replace(/^Pimoroni /, '') ?? 'Connected') : 'Connect badge';
    document.body.classList.toggle('badge-connected', connected);
    document.body.classList.toggle('badge-running', !!runningPath);
  }

  let connecting = null;

  function connect(options) {
    connecting ??= connectNow(options).finally(() => { connecting = null; });
    return connecting;
  }

  async function connectNow({ prompt = true } = {}) {
    if (device.connected) return true;
    try {
      if (!(await device.knownPorts()).length) {
        if (!prompt || !(await askToPair('first'))) {
          setStatus('');
          return false;
        }
      }
      setStatus('Connecting…');
      try {
        await device.connect();
      } catch (error) {
        if (!(error instanceof MissingReplError) || !prompt || !(await askToPair('repl'))) throw error;
        await device.connect();
      }
      setStatus(`Connected to ${device.ident.board}`);
      await badgeFS.reload();
      return true;
    } catch (error) {
      if (error.name === 'NotFoundError' || (error instanceof MissingReplError && !prompt)) {
        setStatus('');
        return false;
      }
      setStatus(error instanceof IncompatibleBadgeError ? 'Incompatible badge' : 'Could not connect');
      output.appendOut('✕ ' + error.message, 'out-error');
      return false;
    } finally {
      render();
    }
  }

  async function disconnect() {
    await device.disconnect();
    setStatus('Disconnected');
  }

  async function run(request, { debug = null } = {}) {
    if (!(await connect())) return;
    if (device.running) {
      await device.stop();
      await device.queue;
    }
    const runTarget = runTargetFor(request?.path ?? null);
    const mapFile = (file) => (file === SCRATCH_PATH ? '<stdin>' : file);
    output.beginRun(request?.tabKey ?? null, debug ? 'Debugging on badge' : 'Running on badge', mapFile);
    try {
      setStatus('Syncing…');
      const files = workspaceFiles();
      if (runTarget.kind === 'scratch') files.push({ path: SCRATCH_PATH, bytes: new TextEncoder().encode(request?.code ?? '') });
      const changed = await device.sync(files, (sent, total, path) => setStatus(`Syncing ${path} ${Math.round((sent / total) * 100)}%`));
      const synced = changed.filter((path) => path !== SCRATCH_PATH).length;
      if (synced) output.appendOut(`Synced ${synced} file${synced === 1 ? '' : 's'} to your badge`, 'out-dim');
      runningPath = runTarget.path;
      render();
      setStatus(debug ? 'Debugging on badge…' : 'Running on badge…');
      const lines = lineSplitter(output.outputLine);
      const result = await device.run(runTarget.path, { debug, onOutput: (text) => lines.push(text) });
      lines.flush();
      const interrupted = /KeyboardInterrupt/.test(result.stderr);
      if (interrupted) output.appendOut('■ Stopped', 'out-dim');
      else if (result.stderr) result.stderr.split('\n').forEach(output.outputLine);
      output.endRun(interrupted ? 'Stopped' : 'Finished');
    } catch (error) {
      output.appendOut('✕ ' + error.message, 'out-error');
      output.endRun(device.connected ? 'Error' : 'Disconnected');
    } finally {
      runningPath = null;
      render();
      badgeFS.reload().catch(() => {});
    }
  }

  async function restartLauncher() {
    if (!device.connected) return;
    if (device.running) await device.stop();
    await device.disconnect();
    output.appendOut('Badge returned to its launcher. Connect again to keep coding.', 'out-dim');
    render();
  }

  async function copyToBadge(userPaths) {
    if (!(await connect())) return;
    const files = userPaths
      .map((path) => [path, workspaceFS.get(path)])
      .filter(([, entry]) => entry && !entry.isDir)
      .map(([path, entry]) => ({ path, bytes: fileBytes(entry) }));
    const changed = await device.sync(files, (sent, total, path) => setStatus(`Copying ${path} ${Math.round((sent / total) * 100)}%`));
    await badgeFS.reload();
    flashStatus(`Copied ${changed.length} file${changed.length === 1 ? '' : 's'} to your badge`, 3000);
  }

  async function copyToSimulator(path, isDir) {
    const paths = isDir ? badgeFS.paths().filter((p) => p.startsWith(path + '/') && !p.endsWith('/')) : [path];
    for (const [index, devicePath] of paths.entries()) {
      setStatus(`Copying ${devicePath} (${index + 1}/${paths.length})`);
      const entry = await badgeFS.load(devicePath);
      const { readOnly, size, ...plain } = entry;
      workspaceFS.set(devicePath, plain);
    }
    flashStatus(`Copied ${paths.length} file${paths.length === 1 ? '' : 's'} to the simulator`, 3000);
  }

  device.addEventListener('disconnected', () => {
    render();
    flashStatus('Badge disconnected', 3000);
  });

  window.addEventListener('pagehide', () => {
    if (device.connected) device.repl.restartFirmware();
  });

  els.connect.addEventListener('click', () => (device.connected ? disconnect() : connect()));
  render();
  const ready = autoConnect ? connect({ prompt: false }) : Promise.resolve(false);

  return {
    ready,
    connect,
    run: async (request) => { await run(request); return true; },
    stop: async () => { await device.stop(); return true; },
    debug: async (request) => {
      if (!(await connect())) return;
      if (!device.canDebug) {
        if (!(await askToPair('debug'))) return;
        await device.disconnect({ restart: false });
        if (!(await connect({ prompt: false })) || !device.canDebug) {
          flashStatus('✕ The debugger connection was not found', 4000);
          return;
        }
      }
      await run(request, { debug: debuggerHooks() });
    },
    restartLauncher,
    copyToBadge,
    copyToSimulator,
  };
}
