export const SCRATCH_PATH = '/.ide/scratch.py';

const APP_PATTERN = /^\/(apps|contrib)\/([^/]+)(\/.*)?$/;

export function appSlug(path) {
  return path?.match(APP_PATTERN)?.[2] ?? null;
}

export function runTargetFor(path) {
  if (!path) return { kind: 'scratch', path: SCRATCH_PATH };
  const match = path.match(APP_PATTERN);
  if (match) return { kind: 'app', slug: match[2], path: `/${match[1]}/${match[2]}` };
  return { kind: 'file', path };
}

export function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function launcherName(slug) {
  return slug.split('_').map((word) => (word.length <= 1 ? word : word[0].toUpperCase() + word.slice(1))).join(' ');
}
