import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildGeneratedCandidate, generateLevelBatch, historicalRarityWeights } from '../static/js/batch-level-generator.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import { decodeLevelDocument } from '../static/js/level-document.js';
import { validateLevelStability } from '../static/js/level-stability-validator.js';
import { compareStructureDescriptors, reconstructLevelStructure } from '../static/js/level-structure.js';
import { exportedLevelFilename } from '../levellist.js';

const { config, assets } = decodeGlobalConfig(JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8')));
const manifest = JSON.parse(await readFile(new URL('../level/导出清单.json', import.meta.url), 'utf8'));
const official = await Promise.all(manifest.levels.map(async entry => decodeLevelDocument(
  JSON.parse(await readFile(new URL(`../level/${exportedLevelFilename(entry)}`, import.meta.url), 'utf8')),
  assets,
)));
const rarityWeights = historicalRarityWeights(official.map(level => reconstructLevelStructure(level, assets)));

const physicalFailures = rejected => ['unstableBounds', 'displacement', 'angle', 'timeout', 'missing', 'damage']
  .reduce((sum, reason) => sum + (rejected[reason] ?? 0), 0);

test('local retries either reject risky geometry or produce a runtime-stable replay', { timeout: 10_000 }, async () => {
  let candidate;
  try {
    candidate = buildGeneratedCandidate({
      seed: 'manual-v2-01', attempt: 4, number: 101, platformType: 'double-3', familyIndex: 4, assets, rarityWeights,
    });
  } catch (error) {
    assert.match(error.message, /风险|稳定|预算/);
    return;
  }
  const result = await validateLevelStability(candidate.level, { config, assets, yieldControl: async () => {} });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('shared gap merge never sends the narrow double-root replay into formal runtime', { timeout: 10_000 }, async () => {
  let candidate;
  try {
    candidate = buildGeneratedCandidate({
      seed: 'manual-v2-01', attempt: 12, number: 101, platformType: 'double-3', familyIndex: 12, assets, rarityWeights,
    });
  } catch (error) {
    assert.match(error.message, /风险|稳定/);
    return;
  }
  const result = await validateLevelStability(candidate.level, { config, assets, yieldControl: async () => {} });
  assert.equal(result.ok, true, JSON.stringify({ result, terminalDepths: candidate.descriptor.complexity.terminalDepths }));
});

test('manual-v2-02 single platform keeps width until its object budget is viable', () => {
  let viable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      buildGeneratedCandidate({
        seed: 'manual-v2-02', attempt, number: 101, platformType: 'single-3', familyIndex: attempt, assets, rarityWeights,
      });
      viable += 1;
    } catch (error) {
      assert.match(error.message, /预算|稳定|改写/);
    }
  }
  assert.ok(viable >= 15, `only ${viable}/20 candidates were viable`);
});

test('manual-v3 seeds keep useful formal-runtime throughput with in-session history', { timeout: 30_000 }, async () => {
  const run = (seed, existingLevels) => generateLevelBatch({
    seed, targetCount: 20, config, assets, existingLevels, validateStability: validateLevelStability,
    maxAttempts: 6, maxDurationMs: 25_000, yieldControl: async () => {},
  });
  const first = await run('manual-v2-01', official);
  const second = await run('manual-v2-02', [...official, ...first.candidates.map(candidate => candidate.level)]);
  const evidence = {
    first: { passed: first.diagnostics.physicsPassed, rejected: first.diagnostics.rejected },
    second: { passed: second.diagnostics.physicsPassed, rejected: second.diagnostics.rejected },
  };
  console.log('MANUAL_SEED_REPLAY', JSON.stringify(evidence));
  assert.ok(first.diagnostics.physicsPassed >= 2 && physicalFailures(first.diagnostics.rejected) <= 2, JSON.stringify(evidence));
  assert.ok(second.diagnostics.physicsPassed >= 2 && physicalFailures(second.diagnostics.rejected) <= 2, JSON.stringify(evidence));
});

test('five-level second seed survives unaccepted in-session history', { timeout: 35_000 }, async () => {
  const options = {
    targetCount: 5, config, assets, validateStability: async () => ({ ok: true }),
    maxAttempts: 80, maxDurationMs: 15_000, yieldControl: async () => {},
  };
  const first = await generateLevelBatch({ ...options, seed: 'manual-v2-01', existingLevels: official });
  const second = await generateLevelBatch({
    ...options, seed: 'manual-v2-02', existingLevels: [...official, ...first.candidates.map(candidate => candidate.level)],
  });
  assert.equal(first.candidates.length, 5, JSON.stringify(first.diagnostics));
  assert.equal(second.candidates.length, 5, JSON.stringify(second.diagnostics));
  const nearest = second.candidates.map(candidate => Math.max(...first.candidates.map(previous => (
    compareStructureDescriptors(candidate.descriptor, previous.descriptor).contourJaccard
  ))));
  assert.ok(nearest.reduce((sum, value) => sum + value, 0) / nearest.length <= 0.7, JSON.stringify(nearest));
  assert.ok(Math.max(...nearest) <= 0.8, JSON.stringify(nearest));
});

