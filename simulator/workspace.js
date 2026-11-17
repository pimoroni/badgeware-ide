import { idbKv } from './util.js';
import { setUserFSBackend, userFS, workspaceFS } from './fs.js';
import { createLocalFS } from './local-fs.js';

const folderStore = idbKv('badgeware.workspace', 'folder');
const FOLDER_KEY = 'handle';
const READ_WRITE = { mode: 'readwrite' };

let current = null;
let waiting = null;

export const localFoldersSupported = () => typeof globalThis.showDirectoryPicker === 'function';

export function workspaceState() {
  if (current) return { kind: 'folder', name: current.name };
  if (waiting) return { kind: 'browser', name: null, reopen: waiting.name };
  return { kind: 'browser', name: null };
}

async function useFolder(handle) {
  const folder = createLocalFS(handle);
  await folder.ready;
  await userFS.flush();
  setUserFSBackend(folder);
  current = handle;
  waiting = null;
}

export async function restoreWorkspace() {
  if (!localFoldersSupported()) return;
  const handle = await folderStore.get(FOLDER_KEY);
  if (!handle) return;
  try {
    if (await handle.queryPermission(READ_WRITE) === 'granted') {
      await useFolder(handle);
      return;
    }
  } catch (error) {
    console.error('Could not reopen the local folder', error);
  }
  waiting = handle;
}

export async function openFolder() {
  const handle = await showDirectoryPicker({ id: 'badgeware-workspace', mode: 'readwrite' });
  await useFolder(handle);
  await folderStore.set(FOLDER_KEY, handle);
  return handle.name;
}

export async function reopenFolder() {
  const handle = waiting;
  if (!handle) return null;
  if (await handle.requestPermission(READ_WRITE) !== 'granted') throw new Error(`Access to ${handle.name} was not allowed.`);
  try {
    await useFolder(handle);
  } catch (error) {
    await forgetFolder();
    throw new Error(`Could not open ${handle.name}: ${error.message}`);
  }
  return handle.name;
}

export async function forgetFolder() {
  await userFS.flush();
  setUserFSBackend(workspaceFS);
  current = null;
  waiting = null;
  await folderStore.set(FOLDER_KEY, null);
}
