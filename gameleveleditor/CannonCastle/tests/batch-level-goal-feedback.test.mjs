import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { generateLevelBatch } from '../static/js/batch-level-generator.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import { decodeLevelDocument } from '../static/js/level-document.js';
import { validateLevelStability } from '../static/js/level-stability-validator.js';
import { exportedLevelFilename } from '../levellist.js';

const { config, assets } = decodeGlobalConfig(JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8')));
const manifest = JSON.parse(await readFile(new URL('../level/导出清单.json', import.meta.url), 'utf8'));
const official = await Promise.all(manifest.levels.map(async entry => decodeLevelDocument(
  JSON.parse(await readFile(new URL(`../level/${exportedLevelFilename(entry)}`, import.meta.url), 'utf8')),
  assets,
)));

test('lefxjm-h40eww early formal-runtime funnel can sustain a 20-level batch', { timeout: 20_000 }, async () => {
  const result = await generateLevelBatch({
    seed: 'lefxjm-h40eww', targetCount: 20, config, assets, existingLevels: official,
    validateStability: validateLevelStability, yieldControl: async () => {}, maxAttempts: 12, maxDurationMs: 90_000,
  });
  const evidence = {
    accepted: result.candidates.length,
    attempted: result.diagnostics.attempted,
    staticPassed: result.diagnostics.staticPassed,
    physicsPassed: result.diagnostics.physicsPassed,
    rejected: result.diagnostics.rejected,
    elapsedMs: Math.round(result.diagnostics.elapsedMs),
  };
  console.log('GOAL_FAST_FEEDBACK', JSON.stringify(evidence));
  assert.ok(result.candidates.length >= 4, JSON.stringify(evidence));
  assert.equal(new Set(result.candidates.map(candidate => candidate.platformType)).size, 4, JSON.stringify(evidence));
  for (const candidate of result.candidates) {
    const total = candidate.level.castle.length;
    const counts = Object.groupBy(candidate.level.castle, object => object.materialId);
    const count = material => counts[material]?.length ?? 0;
    assert.ok(count('stone') + count('metal') >= Math.ceil(total * 0.6));
    assert.ok(count('wood') >= 20 && count('wood') / total >= 0.23 && count('wood') / total <= 0.27);
    assert.ok(count('wood') / total <= 0.3);
    assert.ok(count('glass') >= 8 && count('glass') <= Math.floor(total * 0.1));
    assert.ok(count('stone') >= 6 && count('metal') >= 3 && count('rubber') >= 2);
  }
});

