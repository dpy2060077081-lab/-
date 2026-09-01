import { encodeLevelDocument } from './level-document.js';

const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(view, offset, value) { view.setUint16(offset, value, true); }
function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

export function createStoredZip(files) {
  const entries = files.map(file => {
    const name = encoder.encode(file.name);
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : new Uint8Array(file.content);
    return { name, data, crc: crc32(data), offset: 0 };
  });
  const localSize = entries.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    write32(view, offset, 0x04034b50); write16(view, offset + 4, 20); write16(view, offset + 6, 0x800);
    write16(view, offset + 8, 0); write16(view, offset + 10, 0); write16(view, offset + 12, 0);
    write32(view, offset + 14, entry.crc); write32(view, offset + 18, entry.data.length); write32(view, offset + 22, entry.data.length);
    write16(view, offset + 26, entry.name.length); write16(view, offset + 28, 0);
    output.set(entry.name, offset + 30); output.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralOffset = offset;
  for (const entry of entries) {
    write32(view, offset, 0x02014b50); write16(view, offset + 4, 20); write16(view, offset + 6, 20); write16(view, offset + 8, 0x800);
    write16(view, offset + 10, 0); write16(view, offset + 12, 0); write16(view, offset + 14, 0);
    write32(view, offset + 16, entry.crc); write32(view, offset + 20, entry.data.length); write32(view, offset + 24, entry.data.length);
    write16(view, offset + 28, entry.name.length); write16(view, offset + 30, 0); write16(view, offset + 32, 0);
    write16(view, offset + 34, 0); write16(view, offset + 36, 0); write32(view, offset + 38, 0); write32(view, offset + 42, entry.offset);
    output.set(entry.name, offset + 46); offset += 46 + entry.name.length;
  }
  write32(view, offset, 0x06054b50); write16(view, offset + 4, 0); write16(view, offset + 6, 0);
  write16(view, offset + 8, entries.length); write16(view, offset + 10, entries.length); write32(view, offset + 12, centralSize);
  write32(view, offset + 16, centralOffset); write16(view, offset + 20, 0);
  return output;
}

export function createCandidateZip(candidates) {
  return createStoredZip(candidates.map(candidate => ({
    name: `level-${candidate.level.levelNumber}.json`,
    content: JSON.stringify(encodeLevelDocument(candidate.level), null, 2),
  })));
}

export function batchZipName(seed) {
  const safe = String(seed).trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'seed';
  return `CannonCastle-levels-${safe}.zip`;
}

