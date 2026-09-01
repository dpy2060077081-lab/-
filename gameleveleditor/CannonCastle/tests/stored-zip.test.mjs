import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import { buildGeneratedCandidate } from '../static/js/batch-level-generator.js';
import { batchZipName, createCandidateZip } from '../static/js/stored-zip.js';

const { assets } = decodeGlobalConfig(JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8')));

function storedEntries(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  const entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, content: decoder.decode(zip.subarray(start, start + size)) });
    offset = start + size;
  }
  return entries;
}

test('stored ZIP contains only selected standard v2 level documents', () => {
  const selected = [0, 2].map(index => buildGeneratedCandidate({ seed: 'zip', attempt: index, number: 101 + index, platformType: 'single-5', familyIndex: index, assets }));
  const entries = storedEntries(createCandidateZip(selected));
  assert.deepEqual(entries.map(entry => entry.name), ['level-101.json', 'level-103.json']);
  for (const entry of entries) {
    const document = JSON.parse(entry.content);
    assert.equal(document.version, 2);
    assert.equal(document.type, 'level');
    assert.equal(document.generation, undefined);
    assert.equal(document.level.castle.some(object => object.shape || object.fixedBolt || object.specialType === 'explosive-barrel'), false);
  }
  assert.equal(entries.some(entry => entry.name.includes('导出清单')), false);
  assert.equal(batchZipName(' seed / 中文 '), 'CannonCastle-levels-seed.zip');
});

