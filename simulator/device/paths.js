export const SCRATCH_PATH = '/.ide/scratch.py';

const APP_PATTERN = /^\/apps\/([^/]+)(\/.*)?$/;

export function appSlug(path) {
  return path?.match(APP_PATTERN)?.[1] ?? null;
}

export function runTargetFor(path) {
  if (!path) return { kind: 'scratch', path: SCRATCH_PATH };
  const slug = appSlug(path);
  if (slug) return { kind: 'app', slug, path: `/apps/${slug}` };
  return { kind: 'file', path };
}

export function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function launcherName(slug) {
  return slug.split('_').map((word) => (word.length <= 1 ? word : word[0].toUpperCase() + word.slice(1))).join(' ');
}
