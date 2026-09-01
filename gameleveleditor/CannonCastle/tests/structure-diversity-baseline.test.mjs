import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import { decodeLevelDocument } from '../static/js/level-document.js';
import { jaccard, reconstructLevelStructure } from '../static/js/level-structure.js';
import { exportedLevelFilename } from '../levellist.js';

const globalDocument = JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8'));
const { assets } = decodeGlobalConfig(globalDocument);
const manifest = JSON.parse(await readFile(new URL('../level/导出清单.json', import.meta.url), 'utf8'));
const levels = await Promise.all(manifest.levels.map(async entry => decodeLevelDocument(
  JSON.parse(await readFile(new URL(`../level/${exportedLevelFilename(entry)}`, import.meta.url), 'utf8')), assets,
)));

export function measureLegacyTwenty() {
  const result = {};
  for (const platform of ['double-3', 'single-3', 'single-5', 'double-2']) {
    const descriptors = levels.filter(level => level.platformType === platform).slice(0, 5).map(level => reconstructLevelStructure(level, assets));
    assert.equal(descriptors.length, 5, `missing ${platform} fixture levels`);
    const pairs = descriptors.flatMap((left, index) => descriptors.slice(index + 1).map(right => jaccard(left.contour, right.contour)));
    result[platform] = pairs.reduce((sum, value) => sum + value, 0) / pairs.length;
  }
  return result;
}

test('final-JSON contour metric measures twenty real exported fixture levels', () => {
  const result = measureLegacyTwenty();
  console.log(`STRUCTURAL_DIVERSITY_BASELINE ${JSON.stringify(result)}`);
  assert.equal(Object.keys(result).length, 4);
  assert.ok(Object.values(result).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.ok(new Set(Object.values(result).map(value => value.toFixed(6))).size > 1);
});

