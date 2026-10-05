/* explorer.js — Badgeware Font Explorer
 *
 * A Google-Fonts-style browser for the .af (vector) and .ppf (pixel) fonts
 * shipped with Badgeware. Loads every font listed in simulator/fonts-manifest.json
 * (the exact files the simulator ships, straight from its filesystem — nothing is
 * vendored), renders a live specimen for each into a <canvas>, and lets you:
 *   - type your own specimen text (updates every card live)
 *   - scale the preview size
 *   - filter by vector / pixel
 *   - open a font for a big specimen, a copy-paste code snippet, and a download.
 */

import { afParse, afRender } from './af.js';
import { ppfParse, ppfRender } from './ppf.js';
import { initTargetSwitch, webSerialSupported, currentTarget } from './mode.js';
import { highlightPython } from './font-snippet.js';
import { badgeDevice } from './device/session.js';
import { createConnector } from './device/connect.js';

initTargetSwitch();

const ICON_FONTS_URL = 'https://raw.githubusercontent.com/gadgetoid/iconfont-ppf/main/dist/fonts.js';

const FG = '#f0e8d8';                 // glyph colour (matches badgeware specimens)
const DEFAULT_TEXT = 'The quick brown fox 0123';
// The size control is a whole-number zoom multiplier, not a px size. Pixel fonts
// render at their native pixel size times the multiplier (1x = true pixels, so
// their real sizes are comparable); vector fonts, which have no native size, use
// VECTOR_BASE_PX per 1x. That same px is what the code snippet emits.
const VECTOR_BASE_PX = 20;            // vector font px at 1x

/* All loaded fonts live here: { kind, file, path, name, font, buffer, el, canvas } */
const entries = [];

const state = {
  text: DEFAULT_TEXT,
  scale: 1,           // preview zoom multiplier (1x = native pixels / VECTOR_BASE_PX)
  lores: false,       // badge screen: false = HIRES 320x240, true = LORES 160x120
  filter: 'all',      // 'all' | 'vector' | 'pixel'
};

/* -- DOM handles ---------------------------------------------------------- */
const $ = sel => document.querySelector(sel);
const main       = $('#workspace');
const loadingEl  = $('#loading');
const input      = $('#specimen-input');
const sizeInput  = $('#size-input');
const sizeVal    = $('#size-val');
const filterTabs = $('#filter-tabs');
const resTabs    = $('#res-tabs');

/* Font sources — the same files the simulator ships, loaded straight from the
   emulated filesystem so there's no vendored copy to keep in sync. Vector (.af)
   live under the system assets; pixel (.ppf) live in the ROM. generate_manifest.py
   scans these dirs and writes simulator/fonts-manifest.json. */
const VECTOR_DIR = 'simulator/filesystem/fonts/';
const PIXEL_DIR  = 'simulator/filesystem/rom/fonts/';

/* -- Font loading --------------------------------------------------------- */
async function loadAll() {
  const manifest = await (await fetch('simulator/fonts-manifest.json')).json();

  const jobs = [];
  for (const file of manifest.vector) jobs.push(load('vector', VECTOR_DIR + file, file));
  for (const file of manifest.pixel)  jobs.push(load('pixel',  PIXEL_DIR  + file, file));
  jobs.push(loadIcons());
  await Promise.all(jobs);

  const order = { vector: 0, pixel: 1, icon: 2 };
  entries.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

async function loadIcons() {
  try {
    const source = await (await fetch(ICON_FONTS_URL)).text();
    const categories = JSON.parse(source.slice(source.indexOf('['), source.lastIndexOf(']') + 1));
    for (const category of categories) {
      for (const [variant, label] of [[category, ''], [category.outline, ' outline']]) {
        if (!variant?.b64) continue;
        const bytes = Uint8Array.from(atob(variant.b64), (c) => c.charCodeAt(0));
        const font = ppfParse(bytes.buffer);
        entries.push({
          kind: 'icon', file: variant.file, path: ICON_FONTS_URL.replace('fonts.js', variant.file),
          name: category.title + label, font, buffer: bytes.buffer, glyphs: category.glyphs,
          el: null, canvas: null,
        });
      }
    }
  } catch (err) {
    console.warn('Skipping icon fonts', err);
  }
}

async function load(kind, path, file) {
  try {
    const buffer = await (await fetch(path)).arrayBuffer();
    const font   = kind === 'vector' ? afParse(buffer) : ppfParse(buffer);
    const name   = prettyName(kind, file, font);
    entries.push({ kind, file, path, name, font, buffer, el: null, canvas: null });
  } catch (err) {
    console.warn('Skipping', path, err);
  }
}

/* .ppf files carry an embedded name; .af files don't, so derive from filename.
   Pixel-font names end in the cap height (e.g. "Absolute 10") — drop that; the
   size is already conveyed by the cell-size line. */
function prettyName(kind, file, font) {
  if (kind === 'pixel' && font.name) return font.name.replace(/\s+\d+[a-z]?$/i, '');
  return file.replace(/\.(af|ppf)$/i, '').replace(/[-_]/g, ' ');
}

/* -- Specimen rendering --------------------------------------------------- */
/* Draw `text` for one font into a badge-screen canvas — 320x240 (HIRES) or
   160x120 (LORES) — vertically centred, at zoom multiplier `scale`. The canvas
   backing IS the badge resolution; CSS scales it up to the card (pixelated), so
   LORES reads chunkier and HIRES finer, exactly like the real display. Vector
   fonts render at VECTOR_BASE_PX * scale px; pixel fonts at native size * scale
   (snapped to a whole multiplier). Long lines clip at the screen's right edge. */
function drawSpecimen(entry, canvas, text, scale, lores) {
  if (entry.kind === 'icon') return drawIconSheet(entry, canvas);
  const W = lores ? 160 : 320;      // badge screen resolution
  const H = lores ? 120 : 240;
  const hpad = lores ? 4 : 8;       // small left margin, in badge pixels
  const ctx = canvas.getContext('2d');
  const t   = text.length ? text : ' ';

  canvas.width  = W;
  canvas.height = H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (entry.kind === 'vector') {
    const sizePx = VECTOR_BASE_PX * scale;
    afRender(entry.font, ctx, t, hpad, (H - sizePx) / 2, sizePx, FG);
  } else {
    const gh = entry.font.glyphHeight;
    // The multiplier IS the pixel scale: 1x = true pixels, so native sizes compare.
    const px = Math.max(1, Math.round(scale));
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(px, 0, 0, px, 0, 0);
    ppfRender(entry.font, ctx, t, Math.max(1, Math.round(hpad / px)), Math.round((H / px - gh) / 2), FG);
  }
}

function drawIconSheet(entry, canvas) {
  const W = 320;
  const H = 240;
  const margin = 8;
  const gap = 2;
  const font = entry.font;
  const count = entry.glyphs.length;
  const cellW = font.cellWidth + gap;
  const cellH = font.glyphHeight + gap;
  const fits = (px) => Math.floor((W - margin * 2 + gap * px) / (cellW * px)) * Math.floor((H - margin * 2 + gap * px) / (cellH * px)) >= count;
  let px = 1;
  while (fits(px + 1)) px++;
  const columns = Math.min(count, Math.floor((W - margin * 2 + gap * px) / (cellW * px)));
  const rows = Math.ceil(count / columns);
  const left = Math.floor((W / px - (columns * cellW - gap)) / 2);
  const top = Math.floor((H / px - (rows * cellH - gap)) / 2);

  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(px, 0, 0, px, 0, 0);
  entry.glyphs.forEach((glyph, index) => {
    const glyphWidth = font.glyphs[font.cpMap.get(glyph.char.codePointAt(0))]?.width ?? font.cellWidth;
    const x = left + (index % columns) * cellW + Math.floor((font.cellWidth - glyphWidth) / 2);
    const y = top + Math.floor(index / columns) * cellH;
    ppfRender(font, ctx, glyph.char, x, y, FG);
  });
}

function dimsText(entry) {
  const f = entry.font;
  // Vector: the live rendered px size (tracks the zoom slider), in place of the
  // word "vector". Pixel: just the native pixel height — the width is arbitrary
  // (it varies per glyph), so it's misleading to show.
  return entry.kind === 'vector'
    ? `${Math.round(VECTOR_BASE_PX * state.scale)}px · ${f.glyphCount} glyphs`
    : `${f.glyphHeight}px · ${f.glyphCount} glyphs`;
}

/* -- Gallery -------------------------------------------------------------- */
function buildGallery() {
  loadingEl.remove();

  const vector = entries.filter(e => e.kind === 'vector');
  const pixel  = entries.filter(e => e.kind === 'pixel');
  const icons  = entries.filter(e => e.kind === 'icon');

  main.append(
    section('Vector fonts', '.af', vector),
    section('Pixel fonts', '.ppf', pixel),
  );
  if (icons.length) {
    main.append(section('Icon fonts', '.ppf', icons, 'Converted from nikoichu\'s CC0 <a href="https://nikoichu.itch.io/pixel-icons" target="_blank" rel="noopener">1-bit Pixel Icons</a>. Install one to use it as <code>font.&lt;name&gt;</code>.'));
  }

  refreshSpecimens();
}

function section(title, ext, list, note = null) {
  const frag = document.createDocumentFragment();

  const h = document.createElement('h2');
  h.className = 'section-title';
  h.dataset.kind = list[0]?.kind ?? '';
  h.innerHTML = `${title} <span class="count">${ext} · ${list.length}</span>`;
  if (note) h.insertAdjacentHTML('beforeend', `<small class="section-note">${note}</small>`);
  frag.append(h);

  const grid = document.createElement('div');
  grid.className = 'font-grid';
  grid.dataset.kind = list[0]?.kind ?? '';
  for (const entry of list) grid.append(card(entry));
  frag.append(grid);

  return frag;
}

function card(entry) {
  const el = document.createElement('div');
  el.className = 'font-card';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${entry.name} — open details`);

  const specimen = document.createElement('div');
  specimen.className = 'specimen' + (entry.kind !== 'vector' ? ' pixel' : '');
  const canvas = document.createElement('canvas');
  specimen.append(canvas);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `
    <div class="name-block">
      <span class="name">${escapeHtml(entry.name)}</span>
      <span class="dims">${dimsText(entry)}</span>
    </div>
    <span class="badge ${entry.kind}">${KIND_LABELS[entry.kind]}</span>`;
  if (entry.kind === 'icon' && webSerialSupported()) {
    const install = document.createElement('button');
    install.className = 'install-btn';
    install.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleInstall(entry);
    });
    meta.append(install);
    entry.installButton = install;
  }

  el.append(specimen, meta);
  el.addEventListener('click', () => openModal(entry));
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(entry); }
  });

  entry.el = el;
  entry.canvas = canvas;
  return el;
}

const KIND_LABELS = { vector: 'Vector', pixel: 'Pixel', icon: 'Icons' };

/* Redraw every visible card's specimen (after a text / size / filter change). */
function refreshSpecimens() {
  for (const entry of entries) {
    if (entry.canvas && entry.el.style.display !== 'none') {
      drawSpecimen(entry, entry.canvas, state.text, state.scale, state.lores);
      const dims = entry.el.querySelector('.dims');   // vector px size tracks the zoom
      if (dims) dims.textContent = dimsText(entry);
    }
  }
}

function applyFilter() {
  for (const entry of entries) {
    const show = state.filter === 'all' || state.filter === entry.kind;
    entry.el.style.display = show ? '' : 'none';
  }
  // Hide section headers/grids that have no visible members.
  for (const grid of document.querySelectorAll('.font-grid')) {
    const kind = grid.dataset.kind;
    const visible = state.filter === 'all' || state.filter === kind;
    grid.style.display = visible ? '' : 'none';
    grid.previousElementSibling.style.display = visible ? '' : 'none';
  }
  refreshSpecimens();
}

/* -- Detail modal --------------------------------------------------------- */
const backdrop = $('#modal-backdrop');

function openModal(entry) {
  $('#modal-name').textContent = entry.name;
  const badge = $('#modal-badge');
  badge.textContent = KIND_LABELS[entry.kind];
  badge.className = 'badge ' + entry.kind;

  $('#modal-dims').innerHTML = modalDims(entry);

  const specimen = $('#modal-specimen');
  specimen.className = entry.kind !== 'vector' ? 'pixel' : '';
  specimen.innerHTML = '';
  const canvas = document.createElement('canvas');
  specimen.append(canvas);
  // Render the modal specimen a touch larger than the card thumbnails.
  drawSpecimen(entry, canvas, state.text.length ? state.text : DEFAULT_TEXT, Math.max(state.scale, 3), state.lores);

  renderSnippet(entry);

  const dl = $('#modal-download');
  dl.onclick = () => downloadFont(entry);
  renderGlyphs(entry);
  modalEntry = entry;
  syncInstallButtons();

  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#modal-close').focus();
  backdrop.dataset.entry = entry.file;   // for the live specimen refresh

  // Deep-link the open font so the URL is shareable (like Google Fonts).
  if (location.hash !== '#font=' + entry.file) {
    history.replaceState(null, '', '#font=' + encodeURIComponent(entry.file));
  }
}

function modalDims(entry) {
  const f = entry.font;
  const rows = [
    ['Type',   entry.kind === 'vector' ? 'Vector (.af)' : entry.kind === 'icon' ? 'Icon font (.ppf)' : 'Pixel (.ppf)'],
    ['Glyphs', f.glyphCount],
    ['File',   entry.file],
  ];
  if (entry.kind !== 'vector') {
    rows.splice(2, 0, ['Cell size', `${f.cellWidth}×${f.glyphHeight} px`]);
  }
  const kb = (entry.buffer.byteLength / 1024).toFixed(1);
  rows.push(['Size', `${kb} kB`]);
  return rows.map(([k, v]) => `<span><b>${k}:</b> ${escapeHtml(String(v))}</span>`).join('');
}

function closeModal() {
  backdrop.classList.remove('open');
  document.body.style.overflow = '';
  delete backdrop.dataset.entry;
  if (location.hash.startsWith('#font=')) history.replaceState(null, '', location.pathname + location.search);
}

/* Open the font named in the URL hash (#font=<file>), if any. */
function openFromHash() {
  const m = /^#font=(.+)$/.exec(location.hash);
  if (!m) return;
  const entry = entries.find(e => e.file === decodeURIComponent(m[1]));
  if (entry) openModal(entry);
}

/* -- Code snippet --------------------------------------------------------- */
function snippetFor(entry) {
  const name    = entry.file.replace(/\.(af|ppf)$/i, '');   // bare name, no extension
  if (entry.kind === 'icon') {
    const glyph = entry.glyphs[0];
    const char = glyph.char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return [
      `# Install ${name} on your badge, then:`,
      `screen.font = font.${name}`,
      `screen.pen = color.white`,
      `screen.text("${char}", 10, 10)  # ${glyph.name}`,
    ].join('\n');
  }
  const sample  = (state.text.length ? state.text : 'Hello, badge!').replace(/"/g, '\\"');
  // Vector fonts take a px size; pixel fonts take an integer scale (both in the
  // same screen.text() argument slot) — matching what the preview shows.
  const sizeArg = entry.kind === 'vector'
    ? `, ${Math.round(VECTOR_BASE_PX * state.scale)}`
    : `, ${Math.max(1, Math.round(state.scale))}`;
  const sizeCmt = entry.kind === 'vector' ? '  # size in px' : '  # pixel scale';
  // Pixel fonts are the built-in ROM set: `font.<name>` loads /rom/fonts/<name>.ppf
  // directly. Vector fonts are assets, loaded by name via font.load(). (A pixel
  // name that isn't a valid identifier falls back to font.load.)
  const isPixel  = entry.kind === 'pixel';
  const useAttr  = isPixel && /^[A-Za-z_]\w*$/.test(name);
  const comment  = isPixel
    ? `# ${name} is a built-in ROM pixel font:`
    : `# Copy the font to /fonts on your badge, then:`;
  const loadLine = useAttr ? `my_font = font.${name}` : `my_font = font.load("${name}")`;
  return [
    comment,
    loadLine,
    `screen.font = my_font`,
    `screen.pen = color.white`,
    `screen.text("${sample}", 10, 10${sizeArg})${sizeCmt}`,
  ].join('\n');
}


function renderSnippet(entry) {
  const code = snippetFor(entry);
  $('#modal-code').innerHTML = highlightPython(code);
  $('#modal-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      flashCopied($('#modal-copy'));
    } catch { /* clipboard blocked — no-op */ }
  };
}

function flashCopied(btn) {
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="material-symbols-outlined">check</span>Copied';
  setTimeout(() => { btn.innerHTML = orig; }, 1400);
}

/* -- Icon glyphs and installing -------------------------------------------- */
let modalEntry = null;
let installed = new Set();
let busy = false;
const installStatus = $('#install-status');
const connector = badgeDevice
  ? createConnector({
    device: badgeDevice,
    dialog: $('#pair-dialog'),
    setStatus: (text) => { installStatus.textContent = text; },
    onError: (error) => { installStatus.textContent = '✕ ' + error.message; },
  })
  : null;

function renderGlyphs(entry) {
  const section = $('#modal-glyphs-section');
  const grid = $('#modal-glyphs');
  section.hidden = entry.kind !== 'icon';
  grid.replaceChildren();
  if (entry.kind !== 'icon') return;
  for (const glyph of entry.glyphs) {
    const tile = document.createElement('button');
    tile.className = 'glyph-tile';
    tile.title = `${glyph.name}  "${glyph.char}"  U+${glyph.code}`;
    const canvas = document.createElement('canvas');
    canvas.width = entry.font.cellWidth ?? 16;
    canvas.height = entry.font.glyphHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ppfRender(entry.font, ctx, glyph.char, 0, 0, FG);
    const label = document.createElement('span');
    label.textContent = glyph.name.replace(/_/g, ' ');
    tile.append(canvas, label);
    tile.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(glyph.char);
        installStatus.textContent = `Copied "${glyph.char}" (${glyph.name})`;
      } catch (_) {}
    });
    grid.append(tile);
  }
}

function syncInstallButtons() {
  for (const entry of entries) {
    if (!entry.installButton) continue;
    const isInstalled = installed.has(entry.file);
    entry.installButton.textContent = busy === entry.file ? 'Working…' : isInstalled ? 'Installed' : 'Install';
    entry.installButton.classList.toggle('installed', isInstalled);
    entry.installButton.disabled = !!busy;
  }
  const install = $('#modal-install');
  const remove = $('#modal-remove');
  const isIcon = modalEntry?.kind === 'icon' && !!connector;
  const isInstalled = isIcon && installed.has(modalEntry.file);
  install.hidden = !isIcon || isInstalled;
  remove.hidden = !isIcon || !isInstalled;
  install.disabled = remove.disabled = !!busy;
  install.lastElementChild.textContent = busy ? 'Working…' : 'Install on badge';
}

async function refreshInstalled() {
  if (!badgeDevice?.connected) return;
  installed = new Set(await badgeDevice.romFonts().catch(() => []));
  syncInstallButtons();
}

async function toggleInstall(entry, { remove = installed.has(entry.file) } = {}) {
  if (busy || !connector) return;
  if (!(await connector.connect({ prompt: true }))) return;
  await refreshInstalled();
  busy = entry.file;
  syncInstallButtons();
  try {
    if (remove) {
      installStatus.textContent = `Removing ${entry.file}…`;
      await badgeDevice.romRemove(`fonts/${entry.file}`);
      installStatus.textContent = `Removed ${entry.file} from your badge`;
    } else {
      installStatus.textContent = `Installing ${entry.file}…`;
      await badgeDevice.romInstall(`fonts/${entry.file}`, new Uint8Array(entry.buffer), (sent, total) => {
        installStatus.textContent = `Installing ${entry.file} ${Math.round((sent / total) * 100)}%`;
      });
      installStatus.textContent = `Installed. Use it as font.${entry.file.replace(/\.ppf$/, '')}`;
    }
  } catch (error) {
    installStatus.textContent = '✕ ' + error.message;
  } finally {
    busy = false;
    await refreshInstalled();
  }
}

$('#modal-install').addEventListener('click', () => modalEntry && toggleInstall(modalEntry, { remove: false }));
$('#modal-remove').addEventListener('click', () => modalEntry && toggleInstall(modalEntry, { remove: true }));

/* -- Download ------------------------------------------------------------- */
function downloadFont(entry) {
  const blob = new Blob([entry.buffer], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = entry.file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -- Utilities ------------------------------------------------------------ */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let refreshRAF = 0;
function scheduleRefresh() {
  cancelAnimationFrame(refreshRAF);
  refreshRAF = requestAnimationFrame(() => {
    refreshSpecimens();
    // Also keep an open modal in sync with the live text/size.
    if (backdrop.dataset.entry) {
      const entry = entries.find(e => e.file === backdrop.dataset.entry);
      if (entry) {
        const canvas = $('#modal-specimen canvas');
        if (canvas) drawSpecimen(entry, canvas, state.text.length ? state.text : DEFAULT_TEXT, Math.max(state.scale, 3), state.lores);
        renderSnippet(entry);
      }
    }
  });
}

/* -- Wire up controls ----------------------------------------------------- */
function initControls() {
  input.value = state.text;
  input.addEventListener('input', () => { state.text = input.value; scheduleRefresh(); });

  // Float multiplier; show one decimal without trailing-zero / float-noise ("1×",
  // "1.5×"). Pixel fonts snap to a whole multiplier in drawSpecimen; vector fonts
  // (and the code snippet) use the continuous value.
  const fmtScale = (s) => (Math.round(s * 10) / 10) + '×';
  sizeInput.value = state.scale;
  sizeVal.textContent = fmtScale(state.scale);
  sizeInput.addEventListener('input', () => {
    state.scale = +sizeInput.value;
    sizeVal.textContent = fmtScale(state.scale);
    scheduleRefresh();
  });

  // HIRES (320x240) / LORES (160x120) badge-screen toggle.
  resTabs.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.lores = btn.dataset.res === 'lores';
    for (const b of resTabs.children) b.classList.toggle('active', b === btn);
    scheduleRefresh();
  });

  filterTabs.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    for (const b of filterTabs.children) b.classList.toggle('active', b === btn);
    applyFilter();
  });

  $('#modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) closeModal();
  });
}

/* -- Boot ----------------------------------------------------------------- */
(async function main_() {
  initControls();
  try {
    await loadAll();
    buildGallery();
    syncInstallButtons();
    if (connector && currentTarget() === 'badge' && (await badgeDevice.knownPorts()).length && await connector.connect({ prompt: false })) await refreshInstalled();
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
  } catch (err) {
    loadingEl.textContent = 'Could not load fonts: ' + err.message;
    console.error(err);
  }
})();
