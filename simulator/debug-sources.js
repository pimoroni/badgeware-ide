import { FROZEN_PREFIX, SCRATCH_PATH, frozenSourcePath, librarySourcePath } from './device/paths.js';
import { activeBoard } from './boards.js';
import { nameLocals } from './locals.js';

const CODE_SOURCES = ['user', 'badge', 'sys'];

export const scratchKeyFor = (info) => (info?.source === 'scratch' ? `scratch:${info.name}` : null);

export function tabTarget(info, scratchKey) {
  if (!info || info.view !== 'editor') return null;
  if (info.source === 'scratch') {
    const key = scratchKeyFor(info);
    return { key, file: key === scratchKey ? SCRATCH_PATH : key };
  }
  if (CODE_SOURCES.includes(info.source) && info.path?.endsWith('.py')) return { key: info.path, file: info.path };
  return null;
}

export function frameSourcePath(frame, frozenFiles, systemPaths) {
  if (frame.user) return frame.file;
  return frozenSourcePath(frame.file, frozenFiles) ?? librarySourcePath(frame.file, systemPaths);
}

export function boardSourceProvider(boardFile = (name) => new URL(activeBoard().simulator + name, import.meta.url)) {
  let frozenFiles = new Set();
  let localsTables = null;

  fetch(boardFile('frozen.json'))
    .then((response) => (response.ok ? response.json() : { files: [] }))
    .then(({ files }) => { frozenFiles = new Set(files); })
    .catch(() => {});

  return {
    frozenFiles: () => frozenFiles,
    readFrozen: (path, as) => fetch(boardFile('frozen/' + path.slice(FROZEN_PREFIX.length)))
      .then((response) => {
        if (!response.ok) return null;
        return as === 'text' ? response.text() : response.arrayBuffer();
      }),
    localsTables: () => {
      localsTables ??= fetch(boardFile('locals.json'))
        .then((response) => (response.ok ? response.json() : {}))
        .catch(() => ({}));
      return localsTables;
    },
  };
}

export function createDebugSources({ tabs, provider, systemPaths, inWorkspace, openBadgeFile = null }) {
  let scratchKey = null;

  const sourcePath = (frame) => frameSourcePath(frame, provider.frozenFiles(), systemPaths());

  async function showSource(path, user) {
    if (path === SCRATCH_PATH) {
      if (scratchKey) tabs.focusKey(scratchKey);
      return;
    }
    if (tabs.focusPath(path)) return;
    if (path.startsWith(FROZEN_PREFIX)) await tabs.openBadgeFile(path, provider.readFrozen);
    else if (!user) await tabs.openFile(path, { system: true });
    else if (inWorkspace(path)) await tabs.openFile(path);
    else await openBadgeFile?.(path);
  }

  async function libraryLocals(locals, frame) {
    return nameLocals(locals, await provider.localsTables(), frame);
  }

  return {
    get scratchKey() {
      return scratchKey;
    },
    captureScratch(info) {
      scratchKey = scratchKeyFor(info);
    },
    target: (info) => tabTarget(info, scratchKey),
    sourcePath,
    showSource,
    libraryLocals,
  };
}
