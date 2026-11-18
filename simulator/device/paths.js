export const SCRATCH_PATH = '/.ide/scratch.py';

const APP_PATTERN = /^\/(apps|contrib)\/([^/]+)(\/.*)?$/;

export const FROZEN_PREFIX = '/.frozen/';

export function frozenSourcePath(file, frozenFiles) {
  return frozenFiles.has(file) ? FROZEN_PREFIX + file : null;
}

export function librarySourcePath(file, systemPaths) {
  if (!file || file.startsWith('/') || file.startsWith('<')) return null;
  const path = '/' + file.replace(/^\.frozen\//, '');
  return systemPaths.includes(path) ? path : null;
}

export function appSlug(path) {
  return path?.match(APP_PATTERN)?.[2] ?? null;
}

export function runTargetFor(path) {
  if (!path) return { kind: 'scratch', path: SCRATCH_PATH };
  const match = path.match(APP_PATTERN);
  if (match) return { kind: 'app', slug: match[2], path: `/${match[1]}/${match[2]}` };
  return { kind: 'file', path };
}

export function badgeRunTarget(request, existsOnBadge) {
  const target = runTargetFor(request?.path ?? null);
  if (target.kind !== 'scratch' || !request?.lockedPath) return target;
  const app = runTargetFor(request.lockedPath);
  if (app.kind !== 'app') return target;
  if (request.lockedSource === 'badge' || existsOnBadge(`${app.path}/__init__.py`)) return app;
  return target;
}

export function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function launcherName(slug) {
  return slug.split('_').map((word) => (word.length <= 1 ? word : word[0].toUpperCase() + word.slice(1))).join(' ');
}
