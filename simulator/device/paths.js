export const SCRATCH_PATH = '/.ide/scratch.py';

const APP_PATTERN = /^\/apps\/([^/]+)(\/.*)?$/;
const DEVICE_APP_PATTERN = /^\/system\/apps\/([^/]+)(\/.*)?$/;

export function appSlug(userPath) {
  return userPath?.match(APP_PATTERN)?.[1] ?? null;
}

export function toDevicePath(userPath) {
  const match = userPath.match(APP_PATTERN);
  return match ? `/system/apps/${match[1]}${match[2] ?? ''}` : userPath;
}

export function toUserPath(devicePath) {
  const match = devicePath.match(DEVICE_APP_PATTERN);
  return match ? `/apps/${match[1]}${match[2] ?? ''}` : devicePath;
}

export function runTargetFor(userPath) {
  if (!userPath) return { kind: 'scratch', devicePath: SCRATCH_PATH };
  const slug = appSlug(userPath);
  if (slug) return { kind: 'app', slug, userPath: `/apps/${slug}`, devicePath: `/system/apps/${slug}` };
  return { kind: 'file', userPath, devicePath: toDevicePath(userPath) };
}

export function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const BADGE_APP_PATTERN = /^\/system\/apps\/([^/]+)(\/.*)?$/;

export function badgeRunTarget(path) {
  if (!path) return { kind: 'scratch', devicePath: SCRATCH_PATH };
  const slug = path.match(BADGE_APP_PATTERN)?.[1];
  if (slug) return { kind: 'app', slug, devicePath: `/system/apps/${slug}` };
  return { kind: 'file', devicePath: path };
}

export function pathMapFor(mode) {
  return mode === 'badge'
    ? { toDevice: (path) => path, toEditor: (path) => path, appsRoot: '/system/apps' }
    : { toDevice: toDevicePath, toEditor: toUserPath, appsRoot: '/apps' };
}

export function launcherName(slug) {
  return slug.split('_').map((word) => (word.length <= 1 ? word : word[0].toUpperCase() + word.slice(1))).join(' ');
}
