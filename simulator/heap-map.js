// Decodes a MicroPython GC allocation table: 2 bits per block, four blocks a
// byte, lowest bits first. Kinds are 0 free, 1 head (start of an allocation),
// 2 tail (rest of one) and 3 marked (a head or tail mid-collection).
export const FREE = 0;
export const HEAD = 1;
export const TAIL = 2;
export const MARK = 3;

export function heapMap(table, bytesPerBlock) {
  const kinds = new Uint8Array(table.length * 4);
  let free = 0;
  let allocations = 0;
  let run = 0;
  let largestFree = 0;
  for (let index = 0; index < table.length; index++) {
    const byte = table[index];
    for (let slot = 0; slot < 4; slot++) {
      const kind = (byte >> (slot * 2)) & 3;
      kinds[index * 4 + slot] = kind;
      if (kind === FREE) {
        free++;
        run++;
        if (run > largestFree) largestFree = run;
      } else {
        run = 0;
        if (kind === HEAD) allocations++;
      }
    }
  }
  const blocks = kinds.length;
  return {
    kinds,
    blocks,
    allocations,
    freeBytes: free * bytesPerBlock,
    usedBytes: (blocks - free) * bytesPerBlock,
    largestFreeBytes: largestFree * bytesPerBlock,
    // How much of the free memory is out of reach of one allocation.
    fragmentation: free ? 1 - largestFree / free : 0,
  };
}

// Rows of `width` bytes as "address  hex  ascii", for a memory view.
export function hexDump(bytes, address, width = 16) {
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    const row = bytes.subarray(offset, offset + width);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(width * 3 - 1);
    const text = [...row].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');
    lines.push(`${(address + offset).toString(16).padStart(8, '0')}  ${hex}  ${text}`);
  }
  return lines.join('\n');
}

// RP2350 memory regions as [base, size], for firmware that doesn't report its
// own from mem.heap.
export const DEFAULT_REGIONS = {
  flash: [0x10000000, 16 * 1024 * 1024],
  psram: [0x11000000, 8 * 1024 * 1024],
  sram: [0x20000000, 520 * 1024],
};

const REGION_NAMES = { flash: 'Flash', psram: 'PSRAM', sram: 'SRAM' };

// The absolute address of `offset` (decimal or 0x hex) into a region, checking
// `length` bytes from it fit. Throws with a message for the memory view.
export function regionAddress(regions, region, offsetText, length) {
  const [base, size] = regions[region];
  const text = offsetText.trim() || '0';
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(text)) throw new Error('An offset is a number, e.g. 0 or 0x1000');
  const offset = Number(text);
  if (!size) throw new Error(`This badge has no ${REGION_NAMES[region]}`);
  if (offset + length > size) throw new Error(`That runs past the end of ${REGION_NAMES[region]} (${size / 1024} KB)`);
  return base + offset;
}
