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
