import { createZip, readZip } from '../zip.js';
import { isReadOnlyPath as isRomPath } from './badge-fs.js';

export const SECRETS_PATH = '/secrets.py';

const isJunk = (path) => path.startsWith('/__MACOSX/') || path.split('/').pop() === '.DS_Store';
const pad = (number) => String(number).padStart(2, '0');

export const backupName = (date = new Date()) => `tufty-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;

const ancestors = (path) => {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => '/' + parts.slice(0, index + 1).join('/'));
};

export function backupPaths(listing, { includeSecrets = false } = {}) {
  return listing
    .filter(([path]) => !isRomPath(path))
    .filter(([path]) => includeSecrets || path !== SECRETS_PATH)
    .map(([path, size]) => ({ path, size, isDir: size < 0 }));
}

export function badgePathFromZip(name) {
  const parts = name.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
  return '/' + parts.join('/');
}

export function planRestore(zipFiles, listing, { deleteExtras = false } = {}) {
  const onBadge = new Set(listing.map(([path]) => path));
  const restored = zipFiles
    .map((file) => ({ ...file, path: badgePathFromZip(file.path) }))
    .filter((file) => file.path && !isJunk(file.path));
  const skipped = restored.filter((file) => isRomPath(file.path)).map((file) => file.path);
  const wanted = restored.filter((file) => !isRomPath(file.path));
  const write = wanted
    .filter((file) => !file.isDir)
    .map((file) => ({ path: file.path, bytes: file.bytes, exists: onBadge.has(file.path) }));
  const mkdir = wanted.filter((file) => file.isDir && !onBadge.has(file.path)).map((file) => file.path);

  const remove = [];
  if (deleteExtras) {
    const keep = new Set();
    const protectedPaths = [...onBadge].filter((path) => isRomPath(path) || path === SECRETS_PATH);
    for (const path of [...wanted.map((file) => file.path), ...protectedPaths]) {
      keep.add(path);
      ancestors(path).forEach((dir) => keep.add(dir));
    }
    for (const path of [...onBadge].sort()) {
      if (keep.has(path)) continue;
      if (remove.some((removed) => path.startsWith(removed + '/'))) continue;
      remove.push(path);
    }
  }
  return { write, mkdir, remove, skipped };
}

export async function backupBadge(device, { includeSecrets = false, onProgress = () => {} } = {}) {
  const entries = backupPaths(await device.list('/'), { includeSecrets });
  const total = entries.reduce((sum, entry) => sum + Math.max(entry.size, 0), 0) || 1;
  const files = [];
  let done = 0;
  for (const entry of entries) {
    const name = entry.path.slice(1);
    if (entry.isDir) {
      files.push({ path: name + '/' });
      continue;
    }
    onProgress(`Reading ${entry.path}`, done / total);
    files.push({ path: name, bytes: await device.read(entry.path) });
    done += entry.size;
  }
  onProgress('Compressing...', 1);
  const fileCount = entries.filter((entry) => !entry.isDir).length;
  return { zip: await createZip(files), fileCount };
}

export async function readBackup(file) {
  return readZip(new Uint8Array(await file.arrayBuffer()));
}

export async function restoreBadge(device, plan, { onProgress = () => {} } = {}) {
  if (device.running) await device.stop();
  await device.lock();
  try {
    for (const path of plan.remove) {
      onProgress(`Deleting ${path}`, 0);
      await device.remove(path);
    }
    for (const path of plan.mkdir) await device.makeDirectory(path);
    const changed = await device.sync(plan.write, (sent, total, path) => onProgress(`Writing ${path}`, sent / total), { hold: true });
    return { written: changed.length, removed: plan.remove.length };
  } finally {
    await device.unlock().catch(() => {});
  }
}
