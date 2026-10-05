export const UF2_FAMILY_RP2350_ARM_S = 0xe48bff59;

const UF2_MAGIC_START0 = 0x0a324655;
const UF2_MAGIC_START1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const UF2_FLAG_NOT_MAIN_FLASH = 0x1;
const UF2_FLAG_FAMILY_ID = 0x2000;
const BLOCK_SIZE = 512;
export const SECTOR_SIZE = 4096;

export function parseUf2(bytes, { family = UF2_FAMILY_RP2350_ARM_S } = {}) {
  if (bytes.length % BLOCK_SIZE) throw new Error('Not a UF2 file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectors = new Map();
  let written = 0;
  for (let offset = 0; offset < bytes.length; offset += BLOCK_SIZE) {
    if (view.getUint32(offset, true) !== UF2_MAGIC_START0 || view.getUint32(offset + 4, true) !== UF2_MAGIC_START1 || view.getUint32(offset + 508, true) !== UF2_MAGIC_END) {
      throw new Error('Not a UF2 file');
    }
    const flags = view.getUint32(offset + 8, true);
    const address = view.getUint32(offset + 12, true);
    const size = view.getUint32(offset + 16, true);
    const blockFamily = view.getUint32(offset + 28, true);
    if (flags & UF2_FLAG_NOT_MAIN_FLASH) continue;
    if ((flags & UF2_FLAG_FAMILY_ID) && blockFamily !== family) continue;
    const sectorAddress = address - (address % SECTOR_SIZE);
    if (address + size > sectorAddress + SECTOR_SIZE) throw new Error('UF2 block crosses a sector boundary');
    let sector = sectors.get(sectorAddress);
    if (!sector) {
      sector = new Uint8Array(SECTOR_SIZE).fill(0xff);
      sectors.set(sectorAddress, sector);
    }
    sector.set(bytes.subarray(offset + 32, offset + 32 + size), address - sectorAddress);
    written += size;
  }
  if (!sectors.size) throw new Error('This UF2 has nothing for an RP2350');
  return { sectors: new Map([...sectors].sort(([a], [b]) => a - b)), bytes: written };
}

export function contiguousRuns(sectors) {
  const runs = [];
  for (const address of sectors.keys()) {
    const last = runs.at(-1);
    if (last && last.address + last.length === address) last.length += SECTOR_SIZE;
    else runs.push({ address, length: SECTOR_SIZE });
  }
  return runs;
}
