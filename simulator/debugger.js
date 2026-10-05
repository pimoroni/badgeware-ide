const BREAKPOINTS_KEY = 'badgeware.breakpoints';
const WATCHES_KEY = 'badgeware.watches';
const WATCH_INTERVAL_MS = 1000;

function loadWatches() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHES_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((item) => typeof item === 'string') : [];
  } catch (_) {
    return [];
  }
}

function saveWatches(watches) {
  try {
    localStorage.setItem(WATCHES_KEY, JSON.stringify(watches));
  } catch (_) {}
}

function loadBreakpoints() {
  try {
    const saved = JSON.parse(localStorage.getItem(BREAKPOINTS_KEY) || '{}');
    return new Map(Object.entries(saved).map(([path, lines]) => [path, new Set(lines)]));
  } catch (_) {
    return new Map();
  }
}

function saveBreakpoints(breakpoints) {
  try {
    const plain = Object.fromEntries([...breakpoints].filter(([, lines]) => lines.size).map(([path, lines]) => [path, [...lines]]));
    localStorage.setItem(BREAKPOINTS_KEY, JSON.stringify(plain));
  } catch (_) {}
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export function createDebugger(els, { editor, tabs, setStatus, paths }) {
  const toDevicePath = paths.toDevice;
  const toUserPath = paths.toEditor;
  const breakpoints = loadBreakpoints();
  const breakpointDecorations = editor.createDecorationsCollection();
  const currentLineDecorations = editor.createDecorationsCollection();
  let client = null;
  let stopped = null;
  let selectedFrame = 0;
  const watches = loadWatches();
  let watchTimer = null;
  let watchBusy = false;
  let screenRequest = 0;

  const activeUserPath = () => {
    const info = tabs.activeInfo();
    return info?.source === 'user' && info.view === 'editor' ? info.path : null;
  };

  function renderBreakpoints() {
    const path = activeUserPath();
    const lines = path ? [...(breakpoints.get(path) ?? [])] : [];
    breakpointDecorations.set(lines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'debug-breakpoint',
        glyphMarginHoverMessage: { value: 'Breakpoint' },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })));
    renderCurrentLine();
  }

  function renderCurrentLine() {
    const frame = stopped?.stack[selectedFrame];
    const path = activeUserPath();
    if (!frame || !path || toUserPath(frame.file) !== path) {
      currentLineDecorations.clear();
      return;
    }
    currentLineDecorations.set([{
      range: new monaco.Range(frame.line, 1, frame.line, 1),
      options: { isWholeLine: true, className: 'debug-current-line', glyphMarginClassName: 'debug-current-arrow' },
    }]);
  }

  function syncLinesFromDecorations() {
    const path = activeUserPath();
    if (!path || !breakpoints.has(path)) return;
    const lines = new Set(breakpointDecorations.getRanges().map((range) => range.startLineNumber));
    breakpoints.set(path, lines);
    saveBreakpoints(breakpoints);
  }

  function sendBreakpoints(path) {
    client?.send({ cmd: 'setBreakpoints', file: toDevicePath(path), lines: [...(breakpoints.get(path) ?? [])] });
  }

  function toggleBreakpoint(line) {
    const path = activeUserPath();
    if (!path || !path.endsWith('.py')) return;
    const lines = breakpoints.get(path) ?? new Set();
    if (lines.has(line)) lines.delete(line);
    else lines.add(line);
    breakpoints.set(path, lines);
    saveBreakpoints(breakpoints);
    renderBreakpoints();
    sendBreakpoints(path);
  }

  editor.updateOptions({ glyphMargin: true });
  editor.onMouseDown((event) => {
    const { type, position } = event.target;
    const { GUTTER_GLYPH_MARGIN, GUTTER_LINE_NUMBERS } = monaco.editor.MouseTargetType;
    if ((type === GUTTER_GLYPH_MARGIN || type === GUTTER_LINE_NUMBERS) && position) toggleBreakpoint(position.lineNumber);
  });
  editor.onDidChangeModel(renderBreakpoints);
  editor.onDidChangeModelContent(syncLinesFromDecorations);
  editor.addAction({
    id: 'badgeware.toggle-breakpoint',
    label: 'Toggle Breakpoint',
    keybindings: [monaco.KeyCode.F9],
    run: () => toggleBreakpoint(editor.getPosition().lineNumber),
  });

  function variableRow(variable) {
    const row = element('li', variable.ref ? 'debug-var expandable' : 'debug-var');
    const label = element('div', 'debug-var-label');
    label.append(element('span', 'debug-var-name', variable.name), element('span', 'debug-var-value', variable.value));
    label.title = variable.type;
    row.append(label);
    if (variable.ref) {
      label.addEventListener('click', async () => {
        if (row.classList.toggle('open') && !row.querySelector('ul')) {
          const reply = await client.request({ cmd: 'expand', ref: variable.ref }, 'children');
          row.append(variableList(reply.children));
        }
      });
    }
    return row;
  }

  function variableList(variables) {
    const list = element('ul', 'debug-vars');
    if (!variables.length) list.append(element('li', 'debug-empty', 'Nothing here'));
    variables.forEach((variable) => list.append(variableRow(variable)));
    return list;
  }

  function renderWatches(results = []) {
    els.watchList.replaceChildren(...watches.map((expression, index) => {
      const result = results[index];
      const row = element('li', 'debug-watch-row');
      const remove = element('button', 'debug-watch-remove', '×');
      remove.title = 'Remove watch';
      remove.addEventListener('click', () => {
        watches.splice(index, 1);
        saveWatches(watches);
        renderWatches();
        refreshWatches();
      });
      const value = result?.error
        ? element('span', 'debug-eval-error', result.error)
        : element('span', 'debug-var-value', result ? result.result.value : '…');
      row.append(element('span', 'debug-var-name', expression), value, remove);
      return row;
    }));
  }

  async function refreshWatches() {
    if (!client || watchBusy || !watches.length) return;
    watchBusy = true;
    try {
      const results = [];
      for (const expression of watches) {
        results.push(await client.request({ cmd: 'eval', expr: expression, frame: selectedFrame }, 'evaluated', 3000).catch(() => ({ error: 'No reply (the app may be sleeping)' })));
      }
      if (client) renderWatches(results);
    } finally {
      watchBusy = false;
    }
  }

  function startWatching() {
    clearInterval(watchTimer);
    watchTimer = setInterval(() => { if (!stopped) refreshWatches(); }, WATCH_INTERVAL_MS);
  }

  async function refreshScreen() {
    const id = `screen-${++screenRequest}`;
    const shot = await client.request({ cmd: 'screen' }, 'screen', 10000).catch(() => null);
    if (!shot || !stopped || id !== `screen-${screenRequest}`) return;
    els.screen.width = shot.width;
    els.screen.height = shot.height;
    els.screen.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(shot.payload.buffer, shot.payload.byteOffset, shot.payload.length), shot.width, shot.height), 0, 0);
    els.screen.classList.add('ready');
  }

  async function revealFrame(index) {
    selectedFrame = index;
    const frame = stopped.stack[index];
    els.stack.querySelectorAll('li').forEach((row, i) => row.classList.toggle('selected', i === index));
    if (frame.user) {
      await tabs.openFile(toUserPath(frame.file));
      editor.revealLineInCenterIfOutsideViewport(frame.line);
    }
    renderCurrentLine();
    els.globals.replaceChildren(element('p', 'debug-empty', 'Loading…'));
    const scopes = await client.request({ cmd: 'scopes', frame: index }, 'scopes');
    const hasLocals = Array.isArray(scopes.locals);
    els.localsTitle.hidden = !hasLocals;
    els.locals.hidden = !hasLocals;
    els.locals.replaceChildren(hasLocals ? variableList(scopes.locals) : '');
    els.globals.replaceChildren(variableList(scopes.globals));
  }

  function onStopped({ detail }) {
    stopped = detail;
    document.body.classList.add('debug-paused');
    const top = detail.stack.findIndex((frame) => frame.user);
    setStatus(`Paused (${detail.reason}) at ${toUserPath(detail.stack[0].file)}:${detail.stack[0].line}`);
    els.stack.replaceChildren(...detail.stack.map((frame, index) => {
      const row = element('li', frame.user ? 'user' : 'system');
      row.append(element('span', 'debug-frame-name', frame.name), element('span', 'debug-frame-file', `\u200e${toUserPath(frame.file)}:${frame.line}\u200e`));
      row.addEventListener('click', () => revealFrame(index));
      return row;
    }));
    revealFrame(Math.max(0, top)).then(refreshWatches);
    refreshScreen().catch(() => {});
  }

  function clearPaused() {
    stopped = null;
    els.screen.classList.remove('ready');
    document.body.classList.remove('debug-paused');
    els.stack.replaceChildren();
    els.locals.replaceChildren();
    els.globals.replaceChildren();
    currentLineDecorations.clear();
  }

  function onContinued() {
    clearPaused();
    setStatus('Debugging on badge…');
  }

  function onClosed() {
    clearInterval(watchTimer);
    clearPaused();
    client = null;
    document.body.classList.remove('debugging');
  }

  function command(name) {
    if (!client) return;
    if (name === 'pause' || stopped) client.send({ cmd: name });
  }

  async function evaluate(expression) {
    if (!client || !expression.trim()) return;
    const line = element('div', 'debug-eval-line');
    line.append(element('span', 'debug-eval-input', expression));
    els.evalLog.append(line);
    const reply = await client.request({ cmd: 'eval', expr: expression, frame: selectedFrame }, 'evaluated');
    line.append(reply.error ? element('span', 'debug-eval-error', reply.error) : element('span', 'debug-eval-result', reply.result.value));
    els.evalLog.scrollTop = els.evalLog.scrollHeight;
  }

  els.controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-debug]');
    if (button) command(button.dataset.debug);
  });
  els.watchAdd.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !els.watchAdd.value.trim()) return;
    watches.push(els.watchAdd.value.trim());
    saveWatches(watches);
    els.watchAdd.value = '';
    renderWatches();
    refreshWatches();
  });
  renderWatches();

  els.evalInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    evaluate(els.evalInput.value);
    els.evalInput.value = '';
  });

  return {
    hooks: () => ({
      init: () => ({
        breakpoints: Object.fromEntries([...breakpoints].filter(([, lines]) => lines.size).map(([path, lines]) => [toDevicePath(path), [...lines]])),
      }),
      attach(debugClient) {
        client = debugClient;
        els.evalLog.replaceChildren();
        document.body.classList.add('debugging');
        client.addEventListener('stopped', onStopped);
        client.addEventListener('continued', onContinued);
        client.addEventListener('closed', onClosed);
        renderWatches();
        startWatching();
      },
    }),
  };
}
