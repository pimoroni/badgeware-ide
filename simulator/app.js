/* -- badgeware-web editor entry point ---------------------------------------
   The Monaco-dependent half of the app, and the module graph's entry point. The
   simulator + 3D badge boot separately in boot.js (on import); the tab/model
   system lives in tabs.js and the file browser in filebrowser.js. initApp() just
   wires them together — creates the Monaco editor, hands it to createTabs(), and
   connects the file browser, gallery, mobile nav, run provider and keybindings.
   The bottom awaits Monaco (loaded in parallel via the AMD shim in index.html). */
import { userFS, workspaceFS, getSystemPaths, setSystemPaths } from './fs.js';
import { bootSimulator } from './boot.js';
import { createFileBrowser } from './filebrowser.js';
import { createTabs } from './tabs.js';
import { createEditor } from './editor.js';
import { initResizeHandlers } from './resize.js';
import { createBadgeTarget } from './target.js';
import { createDebugger } from './debugger.js';
import { createIconEditor } from './icon-editor.js';
import { createApp } from './app-scaffold.js';
import { createNewAppDialog } from './new-app-dialog.js';
import { createConfigPane } from './config-pane.js';
import { createFirmwareDialog, latestRelease, updateAvailable } from './firmware.js';
import { badgeDevice, badgeFS, badgeEvents } from './device/session.js';
import { runTargetFor } from './device/paths.js';
import { currentTarget, initTargetSwitch, onTargetChange } from './mode.js';

const APP_BASE = new URL('.', import.meta.url).href;

async function initApp() {
  // Adopt the (already in-flight) simulator boot.
  const { trace, startupFile, run: runCurrent, setRunProvider, notifyRunTarget, setStatus, flashStatus, progressStatus, addActions, setFsChangedHandler, setRunInterceptor, setStopInterceptor, output, simulatorView, runOS } = await bootSimulator();
  initTargetSwitch();
  const mobileNav = document.getElementById('mobile-nav');

  // app.js is the wiring layer: it resolves the DOM by id and injects elements into
  // the leaf modules (which never reach into the document for identity themselves).
  const editorEl  = document.getElementById('editor');

  // Editor instance + its language/theme/completions all live in editor.js.
  const editor = createEditor(editorEl);

  /* -- Mobile tabs ----------------------------------------------------------
     On mobile the panels stack and a top icon bar switches between Gallery /
     Files / Code / Output. selectMobilePanel() flips the visible panel + nav
     highlight; tabs.js calls it (focusTab → 'code', showGallery → 'gallery'), so
     opening a file or example jumps to the Code view. No-ops on desktop. */
  const isMobile = () => matchMedia('(max-width: 767px)').matches;
  function selectMobilePanel(tab) {
    document.body.dataset.mobileTab = tab;
    mobileNav.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'code' && isMobile()) requestAnimationFrame(() => editor.layout());
  }

  // The tab/model system owns all tab state; we hand it the editor-area panes it
  // switches between, plus the editor instance + boot seams (status / run / mobile).
  const tabs = createTabs(
    {
      tabBar:     document.getElementById('tab-bar'),
      editorPane: editorEl,
      imgPreview: document.getElementById('img-preview'),
      help:       document.getElementById('help'),
      config:     document.getElementById('config'),
    },
    { editor, setStatus, flashStatus, notifyRunTarget, selectMobilePanel },
  );

  function setMobileTab(tab) {
    if (tab === 'gallery') { location.href = 'examples.html'; return; }   // gallery is its own page
    if (tab === 'code')    return tabs.focusCodeOrNew();
    selectMobilePanel(tab);   // files / output
  }
  mobileNav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setMobileTab(btn.dataset.tab);
  });

  /* -- File browser (left panel) ---------------------------------------------
     The panel (trees, context menu, FS ops) lives in filebrowser.js; tabs.js owns
     the Monaco models/tabs. Both are handed seams so neither touches the other's
     internals; tabs.connect(fb) closes the loop (it needs fb.syncRows/refresh). */
  let fb = null;
  const iconEditor = createIconEditor(document.getElementById('icon-editor'), {
    userFS,
    onSaved: (path) => {
      fb.refresh();
      flashStatus('Saved ' + path);
    },
  });
  const newAppDialog = createNewAppDialog(document.getElementById('new-app-dialog'), {
    exists: (slug) => !!userFS.get(`/apps/${slug}/__init__.py`) || !!userFS.get(`/apps/${slug}/`),
  });
  async function newApp() {
    const choice = await newAppDialog.open();
    if (!choice) return;
    try {
      const app = await createApp(userFS, choice.name);
      fb.refresh();
      tabs.openFile(app.main, { transient: false });
      if (choice.drawIcon) iconEditor.open(app.icon);
    } catch (error) {
      flashStatus('✕ ' + error.message, 4000);
    }
  }

  const badgeConnected = () => !!badgeDevice?.connected;
  let badge = null;

  async function loadBadgeFile(path, as) {
    const entry = await badgeFS.load(path);
    if (!entry) return null;
    if (as === 'text') return entry.binary ? new TextDecoder().decode(entry.data) : entry.text;
    const bytes = entry.binary ? entry.data : new TextEncoder().encode(entry.text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  function workspaceFilesUnder(path, isDir) {
    return isDir ? workspaceFS.paths().filter((p) => p.startsWith(path + '/') && !p.endsWith('/')) : [path];
  }

  async function guard(task) {
    try {
      await task();
    } catch (error) {
      flashStatus('✕ ' + error.message, 4000);
    }
  }

  fb = createFileBrowser(
    {
      userList:    document.getElementById('fp-user-list'),
      sysTree:     document.getElementById('fp-sys-tree'),
      ctxMenu:     document.getElementById('file-ctx-menu'),
      uploadInput: document.getElementById('fp-upload-input'),
      userHeader:  document.querySelector('#fp-user h2'),
    },
    {
      userFS,
      badgePaths: () => (badgeConnected() ? badgeFS.paths() : null),
      badgeConnected,
      activePath: tabs.activePath,
      activeBadgePath: () => (tabs.activeInfo()?.source === 'badge' ? tabs.activeInfo().path : null),
      openPaths:  tabs.openPaths,
      transientPath: tabs.transientPath,
      isTextFile: tabs.isTextFile,
      openFile:   tabs.openFile,
      openBadgeFile: (path, options) => guard(() => tabs.openBadgeFile(path, loadBadgeFile, options)),
      newScratch: tabs.newScratch,
      onRenamed:  tabs.onRenamed,
      onDeleted:  tabs.onDeleted,
      newApp,
      editIcon:   (path) => iconEditor.open(path),
      copyToBadge: (path, isDir) => guard(() => badge.copyToBadge(workspaceFilesUnder(path, isDir))),
      copyToWorkspace: (path, isDir) => guard(async () => { await badge.copyToSimulator(path, isDir); fb.refresh(); }),
      deleteBadgePath: (path, isDir) => guard(async () => {
        if (!confirm(`Delete ${path}${isDir ? ' and everything in it' : ''} from your badge?`)) return;
        await badgeDevice.remove(path);
        await badgeFS.reload();
      }),
      dirsOpenByDefault: true,
    },
  );
  tabs.connect(fb);

  let fsReloadTimer = null;
  setFsChangedHandler(() => {
    clearTimeout(fsReloadTimer);
    fsReloadTimer = setTimeout(async () => { await userFS.reload(); fb.refresh(); }, 150);
  });

  const debugView = createDebugger(
    {
      controls:  document.getElementById('debug-controls'),
      stack:     document.getElementById('debug-stack'),
      locals:    document.getElementById('debug-locals'),
      localsTitle: document.getElementById('debug-locals-title'),
      globals:   document.getElementById('debug-globals'),
      evalLog:   document.getElementById('debug-eval-log'),
      evalInput: document.getElementById('debug-eval'),
      screen:    document.getElementById('debug-screen'),
      screenTitle: document.getElementById('debug-screen-title'),
      watchList: document.getElementById('debug-watch'),
      watchAdd:  document.getElementById('debug-watch-add'),
    },
    { editor, tabs, setStatus },
  );

  if (badgeDevice) {
    badge = createBadgeTarget(
      {
        connect:      document.getElementById('connect-badge'),
        connectLabel: document.querySelector('#connect-badge span:last-child'),
        pairDialog:   document.getElementById('pair-dialog'),
      },
      {
        device: badgeDevice, badgeFS, output, setStatus, flashStatus, progressStatus, debuggerHooks: debugView.hooks,
        autoConnect: currentTarget() === 'badge',
        onIncompatible: (error) => { if (!error.ident) firmwareDialog.open(null); },
      },
    );
    badgeEvents.addEventListener('change', () => fb.refresh());
    badgeEvents.addEventListener('error', ({ detail }) => flashStatus('✕ ' + detail.message, 4000));
    badgeDevice.addEventListener('disconnected', () => fb.refresh());
  }
  const onBadge = () => currentTarget() === 'badge' && badge;
  setRunInterceptor(async (request) => {
    if (onBadge()) return badge.run(request);
    const app = runTargetFor(request?.path ?? null);
    if (request && app.kind === 'app') request.code = `launch(${JSON.stringify(app.path)})`;
    return false;
  });
  setStopInterceptor(async () => (onBadge() ? badge.stop() : false));

  let firmwareUpdate = null;
  const firmwareDialog = badgeDevice
    ? createFirmwareDialog(document.getElementById('firmware-dialog'), {
      device: badgeDevice,
      connect: (options) => badge.connect(options),
      onFinished: (summary) => { flashStatus(summary, 6000); checkFirmware(); },
    })
    : null;
  async function checkFirmware() {
    if (!badgeDevice?.connected) return;
    firmwareUpdate = updateAvailable(badgeDevice.ident, await latestRelease());
    document.querySelector('#toolbar [data-action="config"]').classList.toggle('update-available', !!firmwareUpdate);
    if (firmwareUpdate) flashStatus(`Firmware ${firmwareUpdate.tag} is available. Open Config to update.`, 6000);
  }
  badgeDevice?.addEventListener('connected', checkFirmware);
  const configPane = createConfigPane(document.getElementById('config'), {
    userFS: badgeFS, flashStatus,
    firmwareText: () => {
      const version = badgeDevice?.ident?.version ?? 'unknown';
      return firmwareUpdate ? `${version} <span class="update">(${firmwareUpdate.tag} available)</span>` : version;
    },
    onFirmware: () => firmwareDialog?.open(badgeDevice?.ident ?? null),
    openFile: (path) => { tabs.toggleView('editor'); guard(() => tabs.openBadgeFile(path, loadBadgeFile, { transient: false })); },
    isConnected: badgeConnected,
  });
  const configButton = document.querySelector('#toolbar [data-action="config"]');
  const configOpen = () => document.getElementById('config').style.display === 'block';
  badgeEvents.addEventListener('change', () => {
    if (configOpen() && document.querySelector('#config form').hidden) configPane.load();
  });
  const debugCurrent = () => (onBadge() ? badge.debug(tabs.getRunRequest()) : flashStatus('Switch to Badge to debug', 3000));

  function applyTarget(target) {
    configButton.disabled = target !== 'badge' || !badgeDevice;
    if (target !== 'badge' && configOpen()) tabs.toggleView('config');
  }
  applyTarget(currentTarget());
  await badge?.ready;
  onTargetChange(async (target) => {
    applyTarget(target);
    if (target === 'badge') {
      await simulatorView.stop();
      output.clear();
      await badge?.connect({ prompt: false });
    } else {
      if (badge && badgeDevice.running) await badgeDevice.stop();
      await runOS();
    }
    fb.refresh();
  });

  // Run provider + traceback markers: boot.js calls these into tabs.
  setRunProvider(tabs.getRunRequest);
  trace.clear = tabs.clearMarkers;
  trace.apply = tabs.applyMarkers;

  // Editor keybindings: F5 runs the current content (boot), Ctrl/Cmd+S saves (tabs).
  editor.addAction({
    id:                 'badgeware.run',
    label:              'Run',
    keybindings:        [monaco.KeyCode.F5],
    contextMenuGroupId: 'navigation',
    contextMenuOrder:   1,
    run:                runCurrent,
  });
  editor.addAction({
    id:                 'badgeware.debug',
    label:              'Debug on Badge',
    keybindings:        [monaco.KeyCode.F6],
    contextMenuGroupId: 'navigation',
    contextMenuOrder:   2,
    run:                debugCurrent,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, tabs.saveCurrentFile);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN, tabs.newScratch);

  // Toolbar actions handled here. Examples leaves for its own page (examples.html);
  // Help toggles the overlay; Editor focuses the code view.
  addActions({
    gallery: () => { location.href = 'examples.html'; },
    apps:    () => { location.href = 'apps.html'; },
    fonts:   () => { location.href = 'fonts.html'; },
    help:    tabs.toggleHelp,
    debug:   debugCurrent,
    config:  () => { if (tabs.toggleView('config')) configPane.load(); },
    editor:  () => tabs.focusCodeOrNew(),
    'run-os': () => (onBadge() ? badge.restartLauncher() : runOS()),
    'badge-refresh': () => guard(() => (badgeConnected() ? badgeFS.reload() : badge?.connect())),
  });

  // Commit the home view FIRST: reopen the saved workspace + honour any ?file= /
  // #name deep-link. bootstrap() picks the view itself (a restored tab, or the
  // gallery when there's nothing to restore) and depends only on IndexedDB — no
  // network. Doing it before the system-list fetch below avoids a brief flash of
  // the gallery while that fetch is in flight when the saved state is a tab.
  await tabs.bootstrap(startupFile);

  /* -- Load system file list (populates the System tree) ----------- */
  try {
    const fsData = await fetch(APP_BASE + 'filesystem.json').then(r => r.json());
    // Manifest shape: { files: { "/path": byteSize } } — we only need the paths here.
    setSystemPaths(Object.keys(fsData.files || {}));
  } catch (_) {}

  fb.refresh();              // initial file tree render
  initResizeHandlers();

  // No auto-run here: bootSimulator() already started main.py in parallel with
  // Monaco loading. The editor is now wired to that running simulator.
}

/* -- Entry point ------------------------------------------------------------
   Wait for Monaco's AMD bundle — index.html loads its loader.js classic (so it
   fetches in parallel with this module graph) and exposes window.monacoReady. The
   simulator already booted on boot.js's import, so the OS runs while Monaco loads. */
await window.monacoReady;
await initApp();
