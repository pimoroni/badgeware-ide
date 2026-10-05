const ROMFS_HEADER = [0xd2, 0xcd, 0x31];
const ROMFS_DIRECTORY = 4;
const ROMFS_FILE = 5;

function readUint(bytes, offset) {
  let value = 0;
  for (;;) {
    const byte = bytes[offset++];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [value, offset];
  }
}

function walk(bytes, start, end, prefix, out) {
  let offset = start;
  while (offset < end) {
    let kind, length;
    [kind, offset] = readUint(bytes, offset);
    if (kind === 0) return;
    [length, offset] = readUint(bytes, offset);
    const next = offset + length;
    if (kind === ROMFS_DIRECTORY || kind === ROMFS_FILE) {
      let nameLength;
      [nameLength, offset] = readUint(bytes, offset);
      const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength));
      offset += nameLength;
      if (kind === ROMFS_DIRECTORY) walk(bytes, offset, next, prefix + name + '/', out);
      else out.push(prefix + name);
    }
    offset = next;
  }
}

export function romfsPaths(image) {
  if (!ROMFS_HEADER.every((byte, i) => image[i] === byte)) return [];
  const [length, start] = readUint(image, ROMFS_HEADER.length);
  const out = [];
  walk(image, start, Math.min(start + length, image.length), '', out);
  return out;
}

export function imageFromSectors(sectors, base, size) {
  const image = new Uint8Array(size).fill(0xff);
  for (const [address, data] of sectors) {
    if (address >= base && address < base + size) image.set(data, address - base);
  }
  return image;
}
