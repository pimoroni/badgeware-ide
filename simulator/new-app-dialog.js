import { slugify, launcherName } from './device/paths.js';

export function createNewAppDialog(dialog, { exists }) {
  const form = dialog.querySelector('form');
  const nameInput = form.elements.name;
  const iconInput = form.elements.icon;
  const folderEl = dialog.querySelector('.new-app-folder');
  const labelEl = dialog.querySelector('.new-app-label');
  const errorEl = dialog.querySelector('.new-app-error');
  const createButton = dialog.querySelector('button[value="create"]');

  function check() {
    const slug = slugify(nameInput.value);
    folderEl.textContent = slug ? `/apps/${slug}/` : '—';
    labelEl.textContent = slug ? launcherName(slug) : '—';
    const error = !nameInput.value.trim()
      ? ''
      : !slug
        ? 'Use at least one letter or number.'
        : exists(slug) ? `You already have an app in /apps/${slug}/.` : '';
    errorEl.textContent = error;
    createButton.disabled = !slug || !!error;
    return slug && !error ? slug : null;
  }

  nameInput.addEventListener('input', check);
  form.addEventListener('submit', (event) => {
    if (event.submitter?.value === 'create' && !check()) event.preventDefault();
  });

  return {
    open() {
      form.reset();
      nameInput.value = '';
      iconInput.checked = true;
      check();
      dialog.returnValue = '';
      dialog.showModal();
      nameInput.focus();
      return new Promise((resolve) => {
        dialog.addEventListener('close', () => {
          resolve(dialog.returnValue === 'create' ? { name: nameInput.value.trim(), drawIcon: iconInput.checked } : null);
        }, { once: true });
      });
    },
  };
}
