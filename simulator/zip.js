const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
const UTF8_NAMES = 0x0800;
const ENCRYPTED = 0x0001;
const VERSION = 20;
const DIRECTORY_ATTRIBUTE = 0x10;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(bytes, stream) {
  const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

export const deflateRaw = (bytes) => transform(bytes, new CompressionStream('deflate-raw'));
export const inflateRaw = (bytes) => transform(bytes, new DecompressionStream('deflate-raw'));

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function packEntry({ path, bytes = new Uint8Array(0) }) {
  const isDir = path.endsWith('/');
  const data = isDir ? new Uint8Array(0) : bytes;
  const compressed = data.length ? await deflateRaw(data) : data;
  const deflate = compressed.length < data.length;
  return {
    name: new TextEncoder().encode(path),
    isDir,
    crc: crc32(data),
    size: data.length,
    method: deflate ? DEFLATED : STORED,
    payload: deflate ? compressed : data,
  };
}

function localHeader(entry, stamp) {
  const header = new Uint8Array(30 + entry.name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_HEADER, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, UTF8_NAMES, true);
  view.setUint16(8, entry.method, true);
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.date, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.payload.length, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.name.length, true);
  view.setUint16(28, 0, true);
  header.set(entry.name, 30);
  return header;
}

function centralHeader(entry, stamp, offset) {
  const header = new Uint8Array(46 + entry.name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_HEADER, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, VERSION, true);
  view.setUint16(8, UTF8_NAMES, true);
  view.setUint16(10, entry.method, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.date, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.payload.length, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.name.length, true);
  view.setUint32(38, entry.isDir ? DIRECTORY_ATTRIBUTE : 0, true);
  view.setUint32(42, offset, true);
  header.set(entry.name, 46);
  return header;
}

function endOfCentral(count, size, offset) {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, END_OF_CENTRAL, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return record;
}

export async function createZip(files, { date = new Date() } = {}) {
  if (files.length > MAX_ENTRIES) throw new Error('Too many files for a zip.');
  const stamp = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const entry = await packEntry(file);
    const header = localHeader(entry, stamp);
    centrals.push(centralHeader(entry, stamp, offset));
    locals.push(header, entry.payload);
    offset += header.length + entry.payload.length;
  }
  if (offset > MAX_SIZE) throw new Error('The backup is too big for a zip.');
  const central = concatBytes(centrals);
  return concatBytes([...locals, central, endOfCentral(files.length, central.length, offset)]);
}

function findEndOfCentral(view) {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - 0xffff);
  for (let offset = last; offset >= first; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL) return offset;
  }
  throw new Error('This is not a zip file.');
}

function centralEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentral(view);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === MAX_ENTRIES || offset === MAX_SIZE) throw new Error('ZIP64 files are not supported.');
  const decoder = new TextDecoder();
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== CENTRAL_HEADER) throw new Error('The zip file is damaged.');
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      crc: view.getUint32(offset + 16, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
      path: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { view, entries };
}

async function unpackEntry(bytes, view, entry) {
  if (entry.flags & ENCRYPTED) throw new Error(`${entry.path} is encrypted.`);
  if (entry.compressedSize === MAX_SIZE || entry.size === MAX_SIZE) throw new Error('ZIP64 files are not supported.');
  if (view.getUint32(entry.localOffset, true) !== LOCAL_HEADER) throw new Error('The zip file is damaged.');
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  const payload = bytes.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === STORED) data = payload.slice();
  else if (entry.method === DEFLATED) data = await inflateRaw(payload);
  else throw new Error(`${entry.path} uses an unsupported compression method.`);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`${entry.path} is damaged (CRC mismatch).`);
  return data;
}

export async function readZip(bytes) {
  const { view, entries } = centralEntries(bytes);
  const files = [];
  for (const entry of entries) {
    const isDir = entry.path.endsWith('/');
    files.push({ path: entry.path, isDir, bytes: isDir ? new Uint8Array(0) : await unpackEntry(bytes, view, entry) });
  }
  return files;
}
