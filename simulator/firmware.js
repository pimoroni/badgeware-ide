import { parseUf2 } from './device/uf2.js';
import { Picoboot, BOOTSEL_FILTERS } from './device/picoboot.js';
import { romfsPaths, imageFromSectors } from './device/romfs.js';

const MANIFEST_URL = 'firmware/manifest.json';
const BOARD = 'tufty2350';
const ROMFS_BASE = 0x10200000;
const ROMFS_SIZE = 0x100000;
const FILESYSTEM_BASE = 0x10300000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const webUsbSupported = () => typeof navigator !== 'undefined' && 'usb' in navigator;

let manifestPromise = null;
export function loadManifest() {
  manifestPromise ??= fetch(MANIFEST_URL).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  return manifestPromise;
}

export async function latestRelease() {
  const manifest = await loadManifest();
  return manifest?.boards?.[BOARD] ?? { ide: [], stock: null };
}

export function updateAvailable(ident, releases) {
  const latest = releases.ide[0];
  if (!latest || !ident?.version) return null;
  return /^v\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/.test(ident.version) && ident.version !== latest.tag ? latest : null;
}

const element = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
};

async function download(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url} (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(received / total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function findBootsel() {
  return (await navigator.usb.getDevices()).find((device) => BOOTSEL_FILTERS.some((f) => f.vendorId === device.vendorId && f.productId === device.productId)) ?? null;
}

export function createFirmwareDialog(dialog, { device, connect, onFinished }) {
  const body = dialog.querySelector('.firmware-body');
  const status = dialog.querySelector('.firmware-status');
  const bar = dialog.querySelector('progress');
  const flashButton = dialog.querySelector('[data-firmware="flash"]');
  const closeButton = dialog.querySelector('[data-firmware="close"]');
  const fileInput = dialog.querySelector('input[type="file"]');
  let plan = null;
  let busy = false;

  const setStatus = (text, progress = null) => {
    status.textContent = text;
    bar.hidden = progress === null;
    if (progress !== null) bar.value = progress;
  };

  function option({ key, title, detail, destructive = false, disabled = false }) {
    const input = element('input', { type: 'radio', name: 'firmware-option', value: key });
    input.disabled = disabled;
    return element('label', { className: 'firmware-option' + (destructive ? ' destructive' : '') }, input,
      element('span', {}, element('b', {}, title), element('small', {}, detail)));
  }

  async function render(ident) {
    const releases = await latestRelease();
    const latest = releases.ide[0];
    const stock = releases.stock;
    const installed = ident?.version ?? (ident ? 'unknown' : 'stock firmware');
    const update = updateAvailable(ident, releases);
    body.replaceChildren(
      element('p', {}, 'On your badge: ', element('b', {}, installed)),
      element('div', { className: 'firmware-options' },
        option({
          key: 'update',
          title: latest ? `Update to ${latest.tag}` : 'Update',
          detail: update ? 'A newer IDE firmware is available. Keeps your files.' : 'Installs the latest IDE firmware. Keeps your files.',
          disabled: !latest || !ident,
        }),
        option({
          key: 'full',
          title: latest ? `Fresh install of ${latest.tag}` : 'Fresh install',
          detail: 'IDE firmware plus the built-in apps. Replaces every file on your badge.',
          destructive: true,
          disabled: !latest,
        }),
        option({
          key: 'stock',
          title: stock ? `Switch back to stock firmware ${stock.tag}` : 'Switch back to stock firmware',
          detail: 'The regular Tufty 2350 firmware with USB disk mode. Replaces every file on your badge.',
          destructive: true,
          disabled: !stock,
        }),
        option({ key: 'file', title: 'Install a .uf2 file', detail: 'From your computer, eg. a CI build.' }),
      ),
      element('label', { className: 'firmware-confirm', hidden: '' }, element('input', { type: 'checkbox' }), ' I understand the files on my badge will be erased'),
    );
    if (!releases.ide.length && !releases.stock) body.append(element('p', { className: 'firmware-note' }, 'No firmware releases are published here yet. You can still install a .uf2 file.'));
    const first = [...body.querySelectorAll('input[name="firmware-option"]')].find((input) => !input.disabled);
    if (first) first.checked = true;
    sync();
  }

  function selected() {
    return body.querySelector('input[name="firmware-option"]:checked')?.value ?? null;
  }

  function sync() {
    const key = selected();
    const destructive = key === 'full' || key === 'stock';
    const confirm = body.querySelector('.firmware-confirm');
    confirm.hidden = !destructive;
    flashButton.disabled = busy || !key || (destructive && !confirm.querySelector('input').checked);
    const ready = flashButton.dataset.ready === 'yes';
    flashButton.textContent = ready ? 'Install' : key === 'file' ? 'Choose file…' : 'Download';
  }

  body.addEventListener('change', sync);

  async function prepare(key) {
    const releases = await latestRelease();
    if (key === 'file') {
      fileInput.value = '';
      const file = await new Promise((resolve) => {
        fileInput.onchange = () => resolve(fileInput.files[0] ?? null);
        fileInput.click();
      });
      if (!file) return null;
      const { sectors } = parseUf2(new Uint8Array(await file.arrayBuffer()));
      return { label: file.name, sectors, keepsFiles: ![...sectors.keys()].some((address) => address >= FILESYSTEM_BASE) };
    }
    const release = key === 'stock' ? releases.stock : releases.ide[0];
    const url = key === 'update' ? release.firmware : release.full;
    const bytes = await download(url, (fraction) => setStatus(`Downloading ${release.tag}…`, fraction));
    return { label: release.tag, sectors: parseUf2(bytes).sectors, keepsFiles: key === 'update' };
  }

  async function savedRomFonts(sectors) {
    if (!device.connected) return [];
    const incoming = new Set(romfsPaths(imageFromSectors(sectors, ROMFS_BASE, ROMFS_SIZE)));
    const fonts = [];
    for (const name of await device.romFonts().catch(() => [])) {
      const path = `fonts/${name}`;
      if (!incoming.has(path)) fonts.push({ path, bytes: await device.read(`/rom/${path}`) });
    }
    return fonts;
  }

  async function bootselDevice() {
    const known = await findBootsel();
    if (known) return known;
    const chosen = navigator.usb.requestDevice({ filters: BOOTSEL_FILTERS });
    return chosen;
  }

  async function install() {
    const key = selected();
    busy = true;
    sync();
    closeButton.disabled = true;
    try {
      if (key === 'file') {
        plan = await prepare(key);
        if (!plan) return;
        setStatus(`Ready to install ${plan.label}${plan.keepsFiles ? '' : '. This file replaces the files on your badge'}. Click Install again to continue.`);
        flashButton.dataset.ready = 'yes';
        return;
      }
      if (flashButton.dataset.ready !== 'yes') {
        plan = await prepare(key);
        setStatus(`Downloaded ${plan.label}. Click Install to reboot your badge and write it.`);
        flashButton.dataset.ready = 'yes';
        return;
      }
      delete flashButton.dataset.ready;
      const fonts = plan.keepsFiles ? await savedRomFonts(plan.sectors) : [];
      setStatus('Restarting your badge in update mode. Pick "RP2350 Boot" if your browser asks.');
      const reboot = device.enterBootloader();
      let usbDevice = await bootselDevice();
      await reboot;
      for (let attempt = 0; attempt < 50 && !usbDevice; attempt++) {
        await sleep(200);
        usbDevice = await findBootsel();
      }
      if (!usbDevice) throw new Error('Your badge did not appear in update mode.');
      const picoboot = new Picoboot(usbDevice);
      await picoboot.open();
      const result = await picoboot.flash(plan.sectors, ({ phase, done, total }) => {
        setStatus(phase === 'check' ? 'Checking what needs writing…' : 'Writing firmware…', total ? done / total : null);
      });
      setStatus('Restarting your badge…', null);
      await picoboot.reboot();
      await picoboot.close();
      let connected = false;
      for (let attempt = 0; attempt < 20 && !connected; attempt++) {
        await sleep(1000);
        connected = await connect({ prompt: false });
      }
      for (const [index, font] of fonts.entries()) {
        setStatus(`Putting back ${font.path} (${index + 1}/${fonts.length})…`);
        await device.romInstall(font.path, font.bytes);
      }
      setStatus(`Installed ${plan.label}. Wrote ${result.written} of ${result.checked} sectors.${connected ? '' : ' Click Connect badge to reconnect.'}`);
      onFinished?.();
    } catch (error) {
      setStatus('✕ ' + (error.name === 'NotFoundError' ? 'No badge was chosen. Click Install to try again.' : error.message));
    } finally {
      busy = false;
      closeButton.disabled = false;
      sync();
    }
  }

  flashButton.addEventListener('click', install);
  closeButton.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  body.addEventListener('change', () => {
    delete flashButton.dataset.ready;
    setStatus('');
  });

  return {
    async open(ident) {
      if (!webUsbSupported()) {
        body.replaceChildren(element('p', {}, 'Installing firmware needs a browser with WebUSB, such as Chrome or Edge.'));
        dialog.showModal();
        return;
      }
      delete flashButton.dataset.ready;
      setStatus('');
      await render(ident);
      dialog.showModal();
    },
  };
}
