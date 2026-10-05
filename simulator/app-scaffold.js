import { slugify } from './device/paths.js';
import { defaultIconPixels, encodeIcon } from './icon-editor.js';

export function appTemplate(title) {
  return `badge.mode(HIRES)

while True:
    screen.pen = color.white
    screen.text(${JSON.stringify(title)}, 10, 80)
    screen.text("Press B to start", 10, 120)

    if BUTTON_B in badge.pressed():
        break

    badge.update()

x = 10

while True:
    if BUTTON_A in badge.held():
        x -= 2
    if BUTTON_C in badge.held():
        x += 2

    screen.pen = color.white
    screen.text("Hello!", x, 100)

    badge.update()
`;
}

export async function createApp(userFS, name, appsRoot = '/apps') {
  const slug = slugify(name);
  if (!slug) throw new Error('Give your app a name with at least one letter or number.');
  const base = `${appsRoot}/${slug}`;
  if (userFS.get(`${base}/__init__.py`)) throw new Error(`You already have an app called ${slug}.`);
  userFS.set(`${appsRoot}/`, { isDir: true });
  userFS.set(`${base}/`, { isDir: true });
  userFS.set(`${base}/__init__.py`, { text: appTemplate(name.trim()), binary: false });
  userFS.set(`${base}/icon.png`, { data: await encodeIcon(defaultIconPixels(slug)), binary: true, mimeType: 'image/png' });
  return { slug, main: `${base}/__init__.py`, icon: `${base}/icon.png` };
}
