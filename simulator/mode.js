const TARGET_KEY = 'badgeware.target';
const TARGET_EVENT = 'badgeware-target';

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

function stored() {
  try {
    return localStorage.getItem(TARGET_KEY);
  } catch (_) {
    return null;
  }
}

export function currentTarget() {
  const target = stored() ?? 'badge';
  return target === 'badge' && webSerialSupported() ? 'badge' : 'simulator';
}

export function setTarget(target) {
  try {
    localStorage.setItem(TARGET_KEY, target);
  } catch (_) {}
  document.body.dataset.target = currentTarget();
  syncTargetButtons();
  window.dispatchEvent(new CustomEvent(TARGET_EVENT, { detail: currentTarget() }));
}

export const onTargetChange = (fn) => window.addEventListener(TARGET_EVENT, ({ detail }) => fn(detail));

export function editorUrl(query = {}) {
  const search = new URLSearchParams(query).toString();
  return 'index.html' + (search ? '?' + search : '');
}

function syncTargetButtons() {
  const target = currentTarget();
  document.querySelectorAll('#target-switch [data-target]').forEach((button) => {
    button.classList.toggle('active', button.dataset.target === target);
    button.setAttribute('aria-pressed', String(button.dataset.target === target));
  });
}

export function initTargetSwitch() {
  document.body.dataset.target = currentTarget();
  syncTargetButtons();
  document.querySelectorAll('#target-switch [data-target]').forEach((button) => {
    button.addEventListener('click', () => setTarget(button.dataset.target));
  });
  disableUnsupported();
}

export function disableUnsupported() {
  if (webSerialSupported()) return;
  const reason = 'Needs a browser with Web Serial, such as Chrome or Edge';
  document.querySelectorAll('#target-switch [data-target="badge"], #toolbar [data-action="config"]').forEach((control) => {
    control.disabled = true;
    control.title = reason;
  });
}
