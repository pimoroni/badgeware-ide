import { screenPixels } from './device/debug.js';
import { SCRATCH_PATH } from './device/paths.js';
import { getSystemPaths, userFS } from './fs.js';
import { boardSourceProvider, createDebugSources } from './debug-sources.js';
import { breakpointEntries, breakpointLines, breakpointOptions, describeBreakpoint, hoverExpression } from './debug-breakpoints.js';
import { DEFAULT_REGIONS, FREE, HEAD, heapMap, hexDump, regionAddress } from './heap-map.js';

const BREAKPOINTS_KEY = 'badgeware.breakpoints';
const WATCHES_KEY = 'badgeware.watches';
const EXCEPTIONS_KEY = 'badgeware.breakOnException';
const SECTIONS_KEY = 'badgeware.debugSections';

// Debug panel sections the user collapsed stay collapsed.
function rememberSections(sections) {
  let closed = [];
  try {
    closed = JSON.parse(localStorage.getItem(SECTIONS_KEY) || '[]');
  } catch (_) {}
  for (const section of sections) {
    if (closed.includes(section.dataset.section)) section.open = false;
    section.addEventListener('toggle', () => {
      const names = [...sections].filter((each) => !each.open).map((each) => each.dataset.section);
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(names));
      } catch (_) {}
    });
  }
}
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
    return new Map(Object.entries(saved).map(([path, entries]) => [path, breakpointLines(entries)]));
  } catch (_) {
    return new Map();
  }
}

function saveBreakpoints(breakpoints) {
  try {
    const plain = Object.fromEntries([...breakpoints].filter(([, lines]) => lines.size).map(([path, lines]) => [path, breakpointEntries(lines)]));
    localStorage.setItem(BREAKPOINTS_KEY, JSON.stringify(plain));
  } catch (_) {}
}

function loadBreakOnException() {
  try {
    return localStorage.getItem(EXCEPTIONS_KEY) !== 'false';
  } catch (_) {
    return true;
  }
}


const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export function createDebugger(els, { editor, tabs, setStatus, openBadgeFile = null, restart = null, deviceClient = () => null, sourceProvider = boardSourceProvider() }) {
  const breakpoints = loadBreakpoints();
  let breakOnException = loadBreakOnException();
  let renderedBreakpoints = [];   // [line, options] in decoration order, to follow edits
  const breakpointDecorations = editor.createDecorationsCollection();
  const currentLineDecorations = editor.createDecorationsCollection();
  const sources = createDebugSources({
    tabs,
    provider: sourceProvider,
    systemPaths: getSystemPaths,
    inWorkspace: (path) => !!userFS.get(path),
    openBadgeFile,
  });
  const { sourcePath } = sources;
  let client = null;
  let stopped = null;
  let selectedFrame = 0;
  const watches = loadWatches();
  let watchTimer = null;
  let watchBusy = false;
  let screenRequest = 0;

  const activeTarget = () => sources.target(tabs.activeInfo());

  function renderBreakpoints() {
    const target = activeTarget();
    renderedBreakpoints = target ? [...(breakpoints.get(target.key) ?? [])] : [];
    breakpointDecorations.set(renderedBreakpoints.map(([line, options]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: options?.logMessage ? 'debug-logpoint' : options ? 'debug-breakpoint debug-conditional' : 'debug-breakpoint',
        glyphMarginHoverMessage: { value: describeBreakpoint(options) },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })));
    renderCurrentLine();
  }

  function renderCurrentLine() {
    const frame = stopped?.stack[selectedFrame];
    const target = activeTarget();
    if (!frame || !target || sourcePath(frame) !== target.file) {
      currentLineDecorations.clear();
      return;
    }
    currentLineDecorations.set([{
      range: new monaco.Range(frame.line, 1, frame.line, 1),
      options: { isWholeLine: true, className: 'debug-current-line', glyphMarginClassName: 'debug-current-arrow' },
    }]);
  }

  // Edits move decorations; carry each breakpoint's options to its new line.
  function syncLinesFromDecorations() {
    const target = activeTarget();
    if (!target || !breakpoints.has(target.key)) return;
    const ranges = breakpointDecorations.getRanges();
    const lines = new Map(ranges.map((range, index) => [range.startLineNumber, renderedBreakpoints[index]?.[1] ?? null]));
    breakpoints.set(target.key, lines);
    renderedBreakpoints = [...lines];
    saveBreakpoints(breakpoints);
  }

  function sendBreakpoints(target) {
    client?.send({ cmd: 'setBreakpoints', file: target.file, lines: breakpointEntries(breakpoints.get(target.key) ?? new Map()) });
  }

  function setBreakpoint(line, options, remove = false) {
    const target = activeTarget();
    if (!target) return;
    const lines = breakpoints.get(target.key) ?? new Map();
    if (remove) lines.delete(line);
    else lines.set(line, options);
    breakpoints.set(target.key, lines);
    saveBreakpoints(breakpoints);
    renderBreakpoints();
    sendBreakpoints(target);
  }

  function toggleBreakpoint(line) {
    const target = activeTarget();
    if (!target) return;
    setBreakpoint(line, null, breakpoints.get(target.key)?.has(line));
  }

  function editBreakpoint(line) {
    const target = activeTarget();
    if (!target || !els.breakpointDialog) return;
    const dialog = els.breakpointDialog;
    const form = dialog.querySelector('form');
    const options = breakpoints.get(target.key)?.get(line) ?? {};
    dialog.querySelector('.breakpoint-line').textContent = `Line ${line}`;
    form.elements.condition.value = options.condition ?? '';
    form.elements.hitCount.value = options.hitCount ?? '';
    form.elements.logMessage.value = options.logMessage ?? '';
    dialog.onclose = () => {
      if (dialog.returnValue === 'save') {
        setBreakpoint(line, breakpointOptions({
          condition: form.elements.condition.value,
          hitCount: form.elements.hitCount.value,
          logMessage: form.elements.logMessage.value,
        }));
      } else if (dialog.returnValue === 'remove') {
        setBreakpoint(line, null, true);
      }
    };
    dialog.showModal();
    form.elements.condition.focus();
  }

  function initialBreakpoints() {
    const entries = [...breakpoints].filter(([key, lines]) => key.startsWith('/') && lines.size);
    if (sources.scratchKey) entries.push([SCRATCH_PATH, breakpoints.get(sources.scratchKey) ?? new Map()]);
    return Object.fromEntries(entries.filter(([, lines]) => lines.size).map(([file, lines]) => [file, breakpointEntries(lines)]));
  }

  function setBreakOnException(enabled) {
    breakOnException = enabled;
    try {
      localStorage.setItem(EXCEPTIONS_KEY, String(enabled));
    } catch (_) {}
    els.exceptionToggle?.setAttribute('aria-pressed', String(enabled));
    client?.send({ cmd: 'setExceptionBreak', enabled });
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
  editor.addAction({
    id: 'badgeware.edit-breakpoint',
    label: 'Edit Breakpoint…',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F9],
    contextMenuGroupId: 'debug',
    run: () => editBreakpoint(editor.getPosition().lineNumber),
  });
  editor.addAction({
    id: 'badgeware.run-to-cursor',
    label: 'Run to Cursor',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F10],
    contextMenuGroupId: 'debug',
    precondition: 'badgewareDebugPaused',
    run: () => {
      const target = activeTarget();
      if (client && stopped && target) client.send({ cmd: 'runTo', file: target.file, line: editor.getPosition().lineNumber });
    },
  });
  const pausedContext = editor.createContextKey('badgewareDebugPaused', false);

  // While paused, hovering a name or dotted attribute shows its value in the
  // selected frame. Calls aren't evaluated: only plain names and attributes.
  monaco.languages.registerHoverProvider('python', {
    async provideHover(model, position) {
      const target = activeTarget();
      if (!client || !stopped || !target || model !== editor.getModel()) return null;
      const text = model.getLineContent(position.lineNumber);
      const expression = hoverExpression(text, position.column - 1);
      if (!expression) return null;
      const reply = await client.request({ cmd: 'eval', expr: expression.text, frame: selectedFrame }, 'evaluated', 2000).catch(() => null);
      if (!reply || reply.error) return null;
      return {
        range: new monaco.Range(position.lineNumber, expression.start + 1, position.lineNumber, expression.end + 1),
        contents: [{ value: '`' + expression.text + '` = ' + '`' + reply.result.value.replace(/`/g, "'") + '`' }],
      };
    },
  });

  function variableRow(variable) {
    const row = element('li', variable.ref ? 'debug-var expandable' : 'debug-var');
    const label = element('div', 'debug-var-label');
    label.append(element('span', 'debug-var-name', variable.name), element('span', 'debug-var-value', variable.value));
    label.title = variable.type;
    if (variable.source) {
      const link = element('button', 'debug-var-source', '↗');
      link.title = `Open ${variable.source.file}:${variable.source.line}`;
      link.addEventListener('click', (event) => {
        event.stopPropagation();
        openSource(variable.source);
      });
      label.append(link);
    }
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

  // Opens where a function was defined, the way stepping into it would.
  async function openSource({ file, line, user }) {
    const path = sourcePath({ file, user });
    if (!path) return setStatus(`${file} isn't in the IDE's copy of the firmware`);
    await sources.showSource(path, user);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
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
    els.screen.getContext('2d').putImageData(new ImageData(screenPixels(shot), shot.width, shot.height), 0, 0);
    els.screen.classList.add('ready');
  }

  async function revealFrame(index) {
    const stop = stopped;
    if (!stop) return;
    selectedFrame = index;
    const frame = stop.stack[index];
    els.stack.querySelectorAll('li').forEach((row, i) => row.classList.toggle('selected', i === index));
    const path = sourcePath(frame);
    if (path && activeTarget()?.file !== path) {
      await sources.showSource(path, frame.user);
      if (stopped !== stop) return;
    }
    if (path && activeTarget()?.file === path) editor.revealLineInCenterIfOutsideViewport(frame.line);
    renderCurrentLine();
    els.globals.replaceChildren(element('p', 'debug-empty', 'Loading…'));
    const scopes = await client.request({ cmd: 'scopes', frame: index }, 'scopes').catch((error) => {
      if (stopped === stop) els.globals.replaceChildren(element('p', 'debug-empty', `Could not read variables: ${error.message}`));
      return null;
    });
    if (!scopes || stopped !== stop) return;
    const hasLocals = Array.isArray(scopes.locals);
    els.localsTitle.hidden = !hasLocals;
    els.locals.hidden = !hasLocals;
    els.locals.replaceChildren(hasLocals ? variableList(scopes.locals) : '');
    els.globals.replaceChildren(variableList(scopes.globals));
  }

  function onStopped({ detail }) {
    stopped = detail;
    pausedContext.set(true);
    document.body.classList.add('debug-paused');
    const top = detail.stack.findIndex((frame) => sourcePath(frame));
    const where = `${detail.stack[0].file}:${detail.stack[0].line}`;
    setStatus(detail.exception ? `Paused on ${detail.exception} at ${where}` : `Paused (${detail.reason}) at ${where}`);
    els.exception.hidden = !detail.exception;
    els.exception.textContent = detail.exception ?? '';
    els.stack.replaceChildren(...detail.stack.map((frame, index) => {
      const row = element('li', (frame.user ? 'user' : 'system') + (frame.unwound ? ' unwound' : ''));
      row.append(element('span', 'debug-frame-name', frame.name), element('span', 'debug-frame-file', `\u200e${frame.file}:${frame.line}\u200e`));
      if (frame.unwound) row.title = 'Already unwound by the exception: its locals are as they were when the exception passed through';
      row.addEventListener('click', () => revealFrame(index));
      return row;
    }));
    revealFrame(Math.max(0, top)).then(refreshWatches).then(refreshScreen).catch(() => {});
  }

  function clearPaused() {
    stopped = null;
    pausedContext.set(false);
    els.exception.hidden = true;
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
    memoryRegions = null;
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
    const reply = await client.request({ cmd: 'eval', expr: expression, frame: selectedFrame }, 'evaluated').catch((error) => ({ error: error.message }));
    line.append(reply.error ? element('span', 'debug-eval-error', reply.error) : element('span', 'debug-eval-result', reply.result.value));
    els.evalLog.scrollTop = els.evalLog.scrollHeight;
  }

  els.controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-debug]');
    if (button) command(button.dataset.debug);
    if (event.target.closest('[data-debug-option="exceptions"]')) setBreakOnException(!breakOnException);
    if (event.target.closest('[data-debug-action="restart"]')) restart?.();
  });
  els.exceptionToggle?.setAttribute('aria-pressed', String(breakOnException));
  rememberSections(document.querySelectorAll('#debug-body .debug-section'));

  // -- Memory: read over the aux channel, so the badge does no walking. It
  // works while an app runs, through the debug session or the badge's own
  // aux client.
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  const memory = () => client ?? deviceClient();
  const LIVE_INTERVAL_MS = 2000;
  const LIVE_SAMPLES = 150;
  let liveTimer = null;
  let liveBusy = false;
  let history = [];

  async function readMemory(address, length) {
    const chunks = [];
    for (let offset = 0; offset < length; offset += 4096) {
      const reply = await memory().request({ cmd: 'mem.read', address: address + offset, length: Math.min(4096, length - offset) }, 'mem.read', 5000);
      chunks.push(reply.payload);
    }
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    chunks.reduce((offset, chunk) => (bytes.set(chunk, offset), offset + chunk.length), 0);
    return bytes;
  }

  // Reads each area's allocation table up to its highest allocated block;
  // everything past that is free, so it needn't be sent.
  async function mapHeap({ quiet = false } = {}) {
    if (!memory()) {
      els.heapStats.textContent = 'Connect your badge to map its heap.';
      return false;
    }
    if (!quiet) els.heapStats.textContent = 'Reading the heap…';
    try {
      const heap = await memory().request({ cmd: 'mem.heap' }, 'mem.heap', 5000);
      const maps = [];
      for (const area of heap.areas) {
        const table = new Uint8Array(area.table_bytes);
        table.set(await readMemory(area.table, Math.min(area.table_bytes, Math.floor(area.last_used_block / 4) + 1)));
        maps.push(heapMap(table, heap.block));
      }
      const total = (key) => maps.reduce((sum, map) => sum + map[key], 0);
      const largest = Math.max(...maps.map((map) => map.largestFreeBytes));
      const free = total('freeBytes');
      els.heapStats.textContent = `${kb(total('usedBytes'))} used in ${total('allocations')} allocations, ${kb(free)} free. `
        + `Largest free block ${kb(largest)} (${Math.round((free ? 1 - largest / free : 0) * 100)}% fragmented).`;
      drawHeap(maps);
      history = history.concat({ used: total('usedBytes'), allocations: total('allocations') }).slice(-LIVE_SAMPLES);
      drawHistory();
      return true;
    } catch (error) {
      els.heapStats.textContent = /EINVAL|timed out|No reply/.test(error.message) ? 'Mapping the heap needs newer badge firmware.' : `Could not read the heap: ${error.message}`;
      return false;
    }
  }

  // Used heap over the live samples: a steady climb that garbage collection
  // never brings back down is a leak.
  function drawHistory() {
    const canvas = els.heapHistory;
    if (!canvas || history.length < 2) return;
    const context = canvas.getContext('2d');
    const { width, height } = canvas;
    const used = history.map((sample) => sample.used);
    const top = Math.max(...used) * 1.1 || 1;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = '#e8a33d';
    context.lineWidth = 1.5;
    context.beginPath();
    used.forEach((value, index) => {
      const x = (index / (LIVE_SAMPLES - 1)) * width;
      const y = height - (value / top) * height;
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    });
    context.stroke();
    canvas.hidden = false;
    canvas.title = `Used heap, last ${history.length} samples ${LIVE_INTERVAL_MS / 1000} s apart: ${kb(Math.min(...used))} to ${kb(Math.max(...used))}`;
  }

  function setLive(enabled) {
    clearInterval(liveTimer);
    liveTimer = null;
    els.heapLive?.setAttribute('aria-pressed', String(enabled));
    if (!enabled) return;
    history = [];
    const sample = async () => {
      if (liveBusy) return;
      liveBusy = true;
      const ok = await mapHeap({ quiet: true });
      liveBusy = false;
      if (!ok) setLive(false);
    };
    liveTimer = setInterval(sample, LIVE_INTERVAL_MS);
    sample();
  }

  // One pixel per group of blocks, brighter the more of the group is in use.
  function drawHeap(maps) {
    const canvas = els.heapCanvas;
    const kinds = maps.length === 1 ? maps[0].kinds : Uint8Array.from(maps.flatMap((map) => [...map.kinds]));
    const pixels = canvas.width * canvas.height;
    const perPixel = Math.max(1, Math.ceil(kinds.length / pixels));
    const image = canvas.getContext('2d').createImageData(canvas.width, canvas.height);
    for (let pixel = 0; pixel * perPixel < kinds.length && pixel < pixels; pixel++) {
      let used = 0;
      let heads = 0;
      const end = Math.min(kinds.length, (pixel + 1) * perPixel);
      for (let block = pixel * perPixel; block < end; block++) {
        if (kinds[block] !== FREE) used++;
        if (kinds[block] === HEAD) heads++;
      }
      const level = used / (end - pixel * perPixel);
      image.data.set([40 + 200 * level, 40 + 120 * level * (heads ? 1 : 0.6), 48, 255], pixel * 4);
    }
    canvas.getContext('2d').putImageData(image, 0, 0);
    canvas.hidden = false;
    canvas.title = `${perPixel} block${perPixel === 1 ? '' : 's'} per pixel`;
  }

  // The badge reports its regions from mem.heap; older firmware doesn't.
  let memoryRegions = null;
  async function regions() {
    memoryRegions ??= (await memory().request({ cmd: 'mem.heap' }, 'mem.heap', 5000).catch(() => null))?.regions ?? DEFAULT_REGIONS;
    return memoryRegions;
  }

  function syncRegionField() {
    const form = els.memoryForm;
    form.elements.address.placeholder = form.elements.region.value ? 'Offset, e.g. 0 or 0x1000' : '0x20000000, or id(name) while paused';
  }

  async function showMemory(event) {
    event.preventDefault();
    if (!memory()) {
      els.memoryDump.textContent = 'Connect your badge to read its memory.';
      return;
    }
    const form = els.memoryForm;
    const text = form.elements.address.value.trim();
    const length = Math.min(4096, Math.max(1, Number(form.elements.size.value) || 128));
    try {
      const region = form.elements.region.value;
      let address = region ? regionAddress(await regions(), region, text, length)
        : /^(0x[0-9a-f]+|\d+)$/i.test(text) ? Number(text) : null;
      if (address === null) {
        if (!stopped) throw new Error('Pause to read an expression, or give an address');
        const reply = await client.request({ cmd: 'eval', expr: text, frame: selectedFrame }, 'evaluated', 3000);
        if (reply.error) throw new Error(reply.error);
        address = Number(reply.result.value);
        if (!Number.isFinite(address)) throw new Error(`${text} is not an address`);
      }
      els.memoryDump.textContent = hexDump(await readMemory(address, length), address);
    } catch (error) {
      els.memoryDump.textContent = /EINVAL/.test(error.message) ? 'That range is outside RAM, flash and the heap.' : error.message;
    }
  }
  els.heapButton?.addEventListener('click', () => mapHeap());
  els.heapLive?.addEventListener('click', () => setLive(liveTimer === null));
  els.memoryForm?.addEventListener('submit', showMemory);
  els.memoryForm?.elements.region.addEventListener('change', syncRegionField);

  function onOutput({ detail }) {
    els.evalLog.append(element('div', 'debug-output', detail.text));
    els.evalLog.scrollTop = els.evalLog.scrollHeight;
  }
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
    hooks: () => {
      sources.captureScratch(tabs.activeInfo());
      return {
        init: () => ({
          breakpoints: initialBreakpoints(),
          breakOnException,
        }),
        attach(debugClient) {
          client = debugClient;
          els.evalLog.replaceChildren();
          document.body.classList.add('debugging');
          client.addEventListener('stopped', onStopped);
          client.addEventListener('continued', onContinued);
          client.addEventListener('closed', onClosed);
          client.addEventListener('output', onOutput);
          renderWatches();
          startWatching();
        },
      };
    },
  };
}
