const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunks(bytes) {
  if (!SIGNATURE.every((value, i) => bytes[i] === value)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

function encodeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function mergeIdat(bytes) {
  const chunks = pngChunks(bytes);
  const idat = chunks.filter((chunk) => chunk.type === 'IDAT');
  if (idat.length <= 1) return bytes;
  const merged = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.data.length, 0));
  let offset = 0;
  for (const chunk of idat) {
    merged.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  const parts = [Uint8Array.from(SIGNATURE)];
  let written = false;
  for (const chunk of chunks) {
    if (chunk.type !== 'IDAT') parts.push(encodeChunk(chunk.type, chunk.data));
    else if (!written) {
      parts.push(encodeChunk('IDAT', merged));
      written = true;
    }
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
