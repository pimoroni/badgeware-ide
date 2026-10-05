const MODE_KEY = 'badgeware.mode';

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

function stored() {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch (_) {
    return null;
  }
}

function remember(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch (_) {}
}

export function currentMode() {
  const requested = new URLSearchParams(location.search).get('mode') ?? stored() ?? 'badge';
  const mode = requested === 'badge' && webSerialSupported() ? 'badge' : 'simulator';
  remember(mode);
  return mode;
}

export function editorUrl(mode, query = '') {
  const params = new URLSearchParams(query);
  params.set('mode', mode);
  return 'index.html?' + params.toString();
}

export function editorUrlFor(element, query = '') {
  return editorUrl(element?.closest('[data-mode]')?.dataset.mode ?? stored() ?? 'badge', query);
}

export function disableUnsupported(root = document) {
  if (webSerialSupported()) return;
  const reason = 'Needs a browser with Web Serial, such as Chrome or Edge';
  root.querySelectorAll('#toolbar [data-mode="badge"], #toolbar [data-action="config"]').forEach((control) => {
    if (control.tagName === 'A') {
      control.removeAttribute('href');
      control.setAttribute('aria-disabled', 'true');
    } else {
      control.disabled = true;
    }
    control.title = reason;
  });
}
