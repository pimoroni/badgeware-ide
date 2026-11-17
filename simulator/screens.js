export const EINK_PALETTE = [[38, 38, 40], [96, 96, 96], [168, 168, 164], [221, 221, 213]];
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const LED_GAMMA = 0.8;
const LED_FLOOR = 0.04;

export const LED_MASK = [
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111110000',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '111111111111111111111111111111111111111',
  '000111110000011110000011110000011111000',
  '000001110000011110000011110000011100000',
  '000000110000011110000011110000011000000',
  '000000010000011110000011110000010000000',
];

const luminance = (data, index) => (0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) / 255;

export function einkPixels({ buffer, width, height }) {
  const source = new Uint8Array(buffer);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const threshold = BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.5;
      const level = Math.min(3, Math.max(0, Math.round(luminance(source, index) * 3 + threshold)));
      const [r, g, b] = EINK_PALETTE[level];
      out[index] = r;
      out[index + 1] = g;
      out[index + 2] = b;
      out[index + 3] = 255;
    }
  }
  return out;
}

export function ledLevels({ buffer, width, height }, cols, rows) {
  const source = new Uint8Array(buffer);
  const mask = rows === LED_MASK.length && cols === LED_MASK[0].length ? LED_MASK : null;
  const levels = [];
  for (let row = 0; row < Math.min(rows, height); row++) {
    for (let col = 0; col < Math.min(cols, width); col++) {
      if (mask && mask[row][col] === '0') continue;
      const level = luminance(source, (row * width + col) * 4);
      if (level < LED_FLOOR) continue;
      levels.push({ col, row, level: Math.pow(level, LED_GAMMA) });
    }
  }
  return levels;
}
