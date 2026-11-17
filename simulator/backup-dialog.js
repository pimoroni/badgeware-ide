import { backupBadge, backupName, planRestore, readBackup, restoreBadge } from './device/backup.js';

const MAX_PREVIEW = 200;

const element = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
};

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function saveDownload(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = element('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function createBackupDialog(dialog, { device, flashStatus, onRestored }) {
  const title = dialog.querySelector('h2');
  const body = dialog.querySelector('.backup-body');
  const status = dialog.querySelector('.backup-status');
  const bar = dialog.querySelector('progress');
  const goButton = dialog.querySelector('[data-backup="go"]');
  const closeButton = dialog.querySelector('[data-backup="close"]');
  const fileInput = dialog.querySelector('input[type="file"]');
  let mode = 'backup';
  let busy = false;
  let backupFiles = null;
  let listing = null;
  let plan = null;

  const setStatus = (text, progress = null) => {
    status.textContent = text;
    bar.hidden = progress === null;
    if (progress !== null) bar.value = progress;
  };

  function setBusy(value) {
    busy = value;
    goButton.disabled = value;
    closeButton.disabled = value;
  }

  function checkbox(name, label, checked) {
    const input = element('input', { type: 'checkbox', name });
    input.checked = checked;
    return element('label', { className: 'backup-option' }, input, ' ', label);
  }

  function renderBackup() {
    title.textContent = 'Back up your badge';
    body.replaceChildren(
      element('p', {}, 'Saves every file on your badge to a .zip on your computer.'),
      checkbox('skip-secrets', 'Leave out secrets.py (it has your WiFi password)', true),
    );
    goButton.textContent = 'Back up';
  }

  function renderRestorePick() {
    title.textContent = 'Restore a backup';
    body.replaceChildren(element('p', {}, 'Pick a backup .zip to put back on your badge.'));
    goButton.textContent = 'Choose file...';
    backupFiles = null;
    plan = null;
  }

  function previewRow(marker, path, className) {
    return element('li', { className }, element('span', { className: 'backup-marker' }, marker), path);
  }

  function renderPlan(fileName) {
    const deleteExtras = body.querySelector('[name="delete-extras"]')?.checked ?? false;
    plan = planRestore(backupFiles, listing, { deleteExtras });
    const added = plan.write.filter((file) => !file.exists).length;
    const bytes = plan.write.reduce((sum, file) => sum + file.bytes.length, 0);
    const rows = [
      ...plan.remove.map((path) => previewRow('-', path, 'remove')),
      ...plan.write.map((file) => previewRow(file.exists ? '~' : '+', file.path, file.exists ? 'replace' : 'add')),
      ...plan.mkdir.map((path) => previewRow('+', path + '/', 'add')),
    ];
    const summary = [`${plural(plan.write.length, 'file')} to write (${added} new, ${formatSize(bytes)})`];
    if (plan.remove.length) summary.push(`${plural(plan.remove.length, 'item')} to delete`);
    if (plan.skipped.length) summary.push(`${plural(plan.skipped.length, 'ROM file')} skipped`);
    body.replaceChildren(
      element('p', {}, 'From ', element('b', {}, fileName), ': ', summary.join(', ') + '.'),
      element('ul', { className: 'backup-preview' }, ...rows.slice(0, MAX_PREVIEW)),
      ...(rows.length > MAX_PREVIEW ? [element('p', { className: 'backup-note' }, `And ${rows.length - MAX_PREVIEW} more.`)] : []),
      checkbox('delete-extras', 'Also delete files on the badge that aren\'t in the backup', deleteExtras),
      element('p', { className: 'backup-note' }, 'Files with the same contents are skipped. secrets.py is never deleted.'),
    );
    body.querySelector('[name="delete-extras"]').addEventListener('change', () => renderPlan(fileName));
    goButton.textContent = 'Restore';
    goButton.disabled = !plan.write.length && !plan.remove.length && !plan.mkdir.length;
  }

  function requireConnection() {
    if (device.connected) return true;
    setStatus('Connect your badge first.');
    return false;
  }

  async function backUp() {
    if (!requireConnection()) return;
    const includeSecrets = !body.querySelector('[name="skip-secrets"]').checked;
    const { zip, fileCount } = await backupBadge(device, { includeSecrets, onProgress: setStatus });
    const name = backupName();
    saveDownload(zip, name);
    const summary = `Saved ${plural(fileCount, 'file')} to ${name} (${formatSize(zip.length)}).`;
    setStatus(summary);
    flashStatus(summary, 4000);
  }

  function pickFile() {
    fileInput.value = '';
    return new Promise((resolve) => {
      fileInput.onchange = () => resolve(fileInput.files[0] ?? null);
      fileInput.oncancel = () => resolve(null);
      fileInput.click();
    });
  }

  async function chooseBackup() {
    if (!requireConnection()) return;
    const file = await pickFile();
    if (!file) return;
    setStatus(`Reading ${file.name}...`);
    backupFiles = await readBackup(file);
    setStatus('Checking the files on your badge...');
    listing = await device.list('/');
    setStatus('');
    renderPlan(file.name);
  }

  async function restore() {
    if (!requireConnection()) return;
    const result = await restoreBadge(device, plan, { onProgress: setStatus });
    await onRestored?.();
    const summary = `Restored your badge. Wrote ${plural(result.written, 'file')}${result.removed ? `, deleted ${result.removed}` : ''}.`;
    setStatus(summary);
    flashStatus(summary, 4000);
    renderRestorePick();
  }

  async function go() {
    setBusy(true);
    try {
      if (mode === 'backup') await backUp();
      else if (!plan) await chooseBackup();
      else await restore();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
      if (plan) goButton.disabled = !plan.write.length && !plan.remove.length && !plan.mkdir.length;
    }
  }

  goButton.addEventListener('click', go);
  closeButton.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });

  return {
    open(nextMode = 'backup') {
      if (busy) return;
      mode = nextMode;
      setStatus('');
      if (mode === 'backup') renderBackup();
      else renderRestorePick();
      dialog.showModal();
    },
  };
}
