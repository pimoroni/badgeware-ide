import { mergeIdat } from './png.js';

export const ICON_SIZE = 24;
const CELL = 16;

const PALETTE = [
  '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
];

const hexToRgba = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
const rgbaToHex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

export async function decodeIcon(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, ICON_SIZE, ICON_SIZE);
  return context.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data;
}

export async function encodeIcon(pixels) {
  const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), ICON_SIZE, ICON_SIZE), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return mergeIdat(new Uint8Array(await blob.arrayBuffer()));
}

export function defaultIconPixels(name) {
  const pixels = new Uint8ClampedArray(ICON_SIZE * ICON_SIZE * 4);
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const [r, g, b] = hexToRgba(PALETTE[8 + (hash % 8)]);
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const corner = Math.min(x, ICON_SIZE - 1 - x) + Math.min(y, ICON_SIZE - 1 - y);
      if (corner < 2) continue;
      const edge = x < 2 || y < 2 || x > ICON_SIZE - 3 || y > ICON_SIZE - 3;
      const shade = edge ? 0.7 : 1;
      pixels.set([r * shade, g * shade, b * shade, 255], (y * ICON_SIZE + x) * 4);
    }
  }
  return pixels;
}

export function createIconEditor(dialog, { userFS, onSaved }) {
  const canvas = dialog.querySelector('.icon-canvas');
  const previews = [...dialog.querySelectorAll('.icon-preview canvas')];
  const paletteEl = dialog.querySelector('.icon-palette');
  const colorInput = dialog.querySelector('.icon-color');
  const title = dialog.querySelector('.icon-title');
  const context = canvas.getContext('2d');
  canvas.width = canvas.height = ICON_SIZE * CELL;

  let pixels = new Uint8ClampedArray(ICON_SIZE * ICON_SIZE * 4);
  let history = [];
  let path = null;
  let tool = 'pencil';
  let colour = hexToRgba(PALETTE[7]);
  let drawing = false;

  for (const hex of PALETTE) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.style.background = hex;
    swatch.dataset.colour = hex;
    swatch.title = hex;
    paletteEl.append(swatch);
  }

  function setColour(rgba) {
    colour = rgba;
    colorInput.value = rgbaToHex(rgba);
    paletteEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.colour === colorInput.value));
  }

  function setTool(next) {
    tool = next;
    dialog.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  }

  function render() {
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const i = (y * ICON_SIZE + x) * 4;
        context.fillStyle = (x + y) % 2 ? '#2a3440' : '#222b35';
        context.fillRect(x * CELL, y * CELL, CELL, CELL);
        if (pixels[i + 3]) {
          context.fillStyle = `rgba(${pixels[i]}, ${pixels[i + 1]}, ${pixels[i + 2]}, ${pixels[i + 3] / 255})`;
          context.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
    }
    context.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    context.beginPath();
    for (let i = 1; i < ICON_SIZE; i++) {
      context.moveTo(i * CELL + 0.5, 0);
      context.lineTo(i * CELL + 0.5, ICON_SIZE * CELL);
      context.moveTo(0, i * CELL + 0.5);
      context.lineTo(ICON_SIZE * CELL, i * CELL + 0.5);
    }
    context.stroke();
    const image = new ImageData(new Uint8ClampedArray(pixels), ICON_SIZE, ICON_SIZE);
    for (const preview of previews) {
      preview.width = preview.height = ICON_SIZE;
      preview.getContext('2d').putImageData(image, 0, 0);
    }
  }

  const cellAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * ICON_SIZE);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * ICON_SIZE);
    return x >= 0 && y >= 0 && x < ICON_SIZE && y < ICON_SIZE ? [x, y] : null;
  };

  function fill(x, y) {
    const start = (y * ICON_SIZE + x) * 4;
    const target = pixels.slice(start, start + 4);
    if (target.every((v, i) => v === colour[i])) return;
    const queue = [[x, y]];
    while (queue.length) {
      const [cx, cy] = queue.pop();
      if (cx < 0 || cy < 0 || cx >= ICON_SIZE || cy >= ICON_SIZE) continue;
      const i = (cy * ICON_SIZE + cx) * 4;
      if (!target.every((v, j) => pixels[i + j] === v)) continue;
      pixels.set(colour, i);
      queue.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  function apply(event) {
    const cell = cellAt(event);
    if (!cell) return;
    const [x, y] = cell;
    const i = (y * ICON_SIZE + x) * 4;
    if (tool === 'picker') {
      if (pixels[i + 3]) setColour([...pixels.slice(i, i + 3), 255]);
      setTool('pencil');
    } else if (tool === 'fill') {
      fill(x, y);
    } else {
      pixels.set(tool === 'eraser' || event.buttons === 2 ? [0, 0, 0, 0] : colour, i);
    }
    render();
  }

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    history.push(pixels.slice());
    drawing = tool === 'pencil' || tool === 'eraser';
    canvas.setPointerCapture(event.pointerId);
    apply(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drawing) apply(event);
  });
  canvas.addEventListener('pointerup', () => { drawing = false; });

  paletteEl.addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-colour]');
    if (swatch) setColour(hexToRgba(swatch.dataset.colour));
  });
  colorInput.addEventListener('input', () => setColour(hexToRgba(colorInput.value)));

  dialog.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tool) setTool(button.dataset.tool);
    if (button.dataset.icon === 'undo' && history.length) {
      pixels = history.pop();
      render();
    }
    if (button.dataset.icon === 'clear') {
      history.push(pixels.slice());
      pixels.fill(0);
      render();
    }
    if (button.dataset.icon === 'cancel') dialog.close();
    if (button.dataset.icon === 'save') {
      const data = await encodeIcon(pixels);
      userFS.set(path, { data, binary: true, mimeType: 'image/png' });
      dialog.close();
      onSaved?.(path);
    }
  });

  dialog.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'z' && history.length) {
      pixels = history.pop();
      render();
    }
  });

  return {
    async open(iconPath) {
      path = iconPath;
      history = [];
      const entry = userFS.get(path);
      pixels = new Uint8ClampedArray(ICON_SIZE * ICON_SIZE * 4);
      if (entry?.binary) {
        try {
          pixels = new Uint8ClampedArray(await decodeIcon(entry.data));
        } catch (_) {}
      }
      title.textContent = path;
      setTool('pencil');
      setColour(colour);
      render();
      dialog.showModal();
    },
  };
}
