import { FROZEN_PREFIX, SCRATCH_PATH, frozenSourcePath, librarySourcePath } from './device/paths.js';
import { activeBoard } from './boards.js';

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

// Whether the badge runs the firmware the board bundle's frozen sources came
// from: true, false, or null when either side can't say. The badge reports `git
// describe` of its board repo, the bundle its commit and its own describe.
export function bundleMatches(ident, bundle) {
  const version = ident?.version?.replace(/-dirty$/, '');
  if (!version || version === 'unknown' || !bundle?.commit) return null;
  const commit = version.match(/(?:^|-g)([0-9a-f]{7,40})$/)?.[1];
  return commit ? bundle.commit.startsWith(commit) : version === bundle.version;
}

export const loadBundleInfo = (boardFile = (name) => new URL(activeBoard().simulator + name, import.meta.url)) =>
  fetch(boardFile('bundle.json')).then((response) => (response.ok ? response.json() : null)).catch(() => null);

export function boardSourceProvider(boardFile = (name) => new URL(activeBoard().simulator + name, import.meta.url)) {
  let frozenFiles = new Set();

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
  };
}
