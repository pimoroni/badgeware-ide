import { IncompatibleBadgeError } from './device/badge.js';
import { badgeRunTarget, toDevicePath, toUserPath, SCRATCH_PATH } from './device/paths.js';
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

export function createBadgeTarget(els, { device, badgeFS, output, setStatus, flashStatus, debuggerHooks }) {
  let runningPath = null;

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
        if (!prompt) return false;
        await device.requestPort();
      }
      setStatus('Connecting…');
      await device.connect();
      setStatus(`Connected to ${device.ident.board}`);
      if (!device.canDebug) output.appendOut('Debugging is unavailable: the debug port was not found.', 'out-dim');
      await badgeFS.reload();
      return true;
    } catch (error) {
      if (error.name === 'NotFoundError') {
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
    const runTarget = badgeRunTarget(request?.path ?? null);
    const mapFile = (file) => (file === SCRATCH_PATH ? '<stdin>' : file);
    output.beginRun(request?.tabKey ?? null, debug ? 'Debugging on badge' : 'Running on badge', mapFile);
    try {
      setStatus('Saving…');
      await badgeFS.flush();
      if (runTarget.kind === 'scratch') await device.write(SCRATCH_PATH, new TextEncoder().encode(request?.code ?? ''));
      runningPath = runTarget.devicePath;
      render();
      setStatus(debug ? 'Debugging on badge…' : 'Running on badge…');
      const lines = lineSplitter(output.outputLine);
      const result = await device.run(runTarget.devicePath, { debug, onOutput: (text) => lines.push(text) });
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
      .map(([path, entry]) => ({ path: toDevicePath(path), bytes: fileBytes(entry) }));
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
      workspaceFS.set(toUserPath(devicePath), plain);
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
  const ready = connect({ prompt: false });

  return {
    ready,
    run: async (request) => { await run(request); return true; },
    stop: async () => { await device.stop(); return true; },
    debug: (request) => run(request, { debug: debuggerHooks() }),
    restartLauncher,
    copyToBadge,
    copyToSimulator,
  };
}
