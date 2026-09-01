import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import {
  buildGeneratedCandidate, generateLevelBatch, GENERATOR_VERSION, historicalRarityWeights, reserveCandidateNumbers,
  validateGeneratedCandidate, validateMacroFamilyContract,
} from '../static/js/batch-level-generator.js';
import { validateLevelStability } from '../static/js/level-stability-validator.js';
import { decodeLevelDocument } from '../static/js/level-document.js';
import { exportedLevelFilename } from '../levellist.js';
import { isNearDuplicate, reconstructLevelStructure, structureSignature } from '../static/js/level-structure.js';

const globalDocument = JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8'));
const { config, assets } = decodeGlobalConfig(globalDocument);
const manifest = JSON.parse(await readFile(new URL('../level/导出清单.json', import.meta.url), 'utf8'));
const historicalLevels = await Promise.all(manifest.levels.map(async entry => decodeLevelDocument(
  JSON.parse(await readFile(new URL(`../level/${exportedLevelFilename(entry)}`, import.meta.url), 'utf8')),
  assets,
)));

function buildFixture(options) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { return buildGeneratedCandidate({ ...options, attempt, familyIndex: attempt, assets }); } catch {}
  }
  throw new Error(`no constructible fixture for ${options.seed}/${options.platformType}`);
}

const contourSimilarity = (left, right, predicate) => {
  const select = descriptor => new Set([...descriptor.contour].filter(cell => predicate(Number(cell.split(',')[1]))));
  const leftCells = select(left);
  const rightCells = select(right);
  const intersection = [...leftCells].filter(cell => rightCells.has(cell)).length;
  return intersection / (leftCells.size + rightCells.size - intersection || 1);
};

test('macro fingerprint rejects the same massing even when local topology details differ', () => {
  const candidate = buildFixture({
    seed: 'macro-fingerprint',
    number: 101,
    platformType: 'single-5',
  });
  const left = candidate.descriptor;
  const right = structuredClone(left);

  right.contour = new Set(['0,0']);
  right.whitespace = new Set(['31,31']);
  right.supportSignature = 'different-local-support';
  right.layerVector = [];

  const comparison = isNearDuplicate(left, right);
  assert.equal(comparison.macroFingerprintEqual, true);
  assert.equal(comparison.duplicate, true);
});

test('macro family contracts accept their intended profiles and reject broken massing', () => {
  const band = (spanCount, envelopeWidth, centerOffset = 0, centerVoid = false, largestSpanWidth = envelopeWidth) => ({
    spanCount, envelopeWidth, largestSpanWidth, centerOffset,
    voidCount: Number(centerVoid), centerVoid,
  });
  const fixtures = {
    'stepped-keep': [
      band(2, 0.95), band(2, 0.84), band(2, 0.72), band(1, 0.60), band(1, 0.47), band(1, 0.36),
    ],
    gatehouse: [
      band(2, 0.90, 0, true), band(2, 0.86, 0, true), band(2, 0.80, 0, true),
      band(2, 0.68), band(1, 0.56), band(1, 0.46),
    ],
    'asymmetric-keep': [
      band(2, 0.94), band(2, 0.84, 0.06), band(2, 0.72, 0.12),
      band(1, 0.60, 0.18), band(1, 0.50, 0.22), band(1, 0.40, 0.27),
    ],
    'central-hall': [
      band(2, 0.84), band(2, 0.82), band(2, 0.78), band(1, 0.70), band(1, 0.60, 0, false, 0.52), band(1, 0.54, 0, false, 0.48),
    ],
    'bridge-fortress': [
      band(2, 0.94, 0, true), band(2, 0.90, 0, true), band(2, 0.86, 0, true),
      band(2, 0.82), band(2, 0.76, 0, true), band(2, 0.70, 0, true),
    ],
    'zigzag-terrace': [
      band(2, 0.96), band(2, 0.84, 0.16), band(2, 0.72, -0.16),
      band(2, 0.60, 0.20), band(1, 0.48, 0.12), band(1, 0.38, 0.08),
    ],
  };
  const breakProfile = {
    'stepped-keep': profile => profile.map((value, index) => index >= 4 ? { ...value, envelopeWidth: 0.84 } : value),
    gatehouse: profile => profile.map(value => ({ ...value, centerVoid: false })),
    'asymmetric-keep': profile => profile.map(value => ({ ...value, centerOffset: 0.02 })),
    'central-hall': profile => profile.map((value, index) => index >= 4 ? { ...value, envelopeWidth: 0.30, largestSpanWidth: 0.25 } : value),
    'bridge-fortress': profile => profile.map(value => ({ ...value, centerVoid: false })),
    'zigzag-terrace': profile => profile.map(value => ({ ...value, centerOffset: Math.abs(value.centerOffset) })),
  };

  for (const [key, macroProfile] of Object.entries(fixtures)) {
    assert.equal(validateMacroFamilyContract({ macroProfile }, key).ok, true, key);
    assert.equal(validateMacroFamilyContract({ macroProfile: breakProfile[key](structuredClone(macroProfile)) }, key).ok, false, key);
  }
});

test('five-level batch deterministically covers four macro families without repeated massing', async () => {
  const options = {
    seed: 'macro-family-acceptance',
    targetCount: 5,
    config,
    assets,
    existingLevels: [],
    maxAttempts: 200,
    validateStability: async () => ({ ok: true }),
    yieldControl: async () => {},
  };

  const first = await generateLevelBatch(options);
  const second = await generateLevelBatch(options);
  const familyCounts = Object.values(Object.groupBy(
    first.candidates,
    candidate => candidate.macroFamilyKey,
  )).map(group => group.length);

  assert.equal(first.candidates.length, 5, JSON.stringify(first.diagnostics));
  assert.ok(new Set(first.candidates.map(candidate => candidate.macroFamilyKey)).size >= 4);
  assert.ok(Math.max(...familyCounts) <= 2);
  assert.equal(new Set(first.candidates.map(candidate => candidate.descriptor.macroFingerprint)).size, 5);
  assert.deepEqual(first.candidates, second.candidates);
});

test('same-platform candidates vary their lower structural base, not only the crown', () => {
  const candidates = Array.from({ length: 5 }, (_, baseIndex) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        return buildGeneratedCandidate({
          seed: `lower-base-variety-${baseIndex}`, attempt, familyIndex: baseIndex,
          number: 101 + baseIndex, platformType: 'single-3', assets, shiftFamilyOnRetry: false,
          budgetExponent: 3, preserveParallelRatio: 0.35, terminationRatio: 0.75,
          adaptiveConnections: true, wideStructuralFallback: true, randomizeCross: true,
        });
      } catch {}
    }
    throw new Error(`no lower-base fixture for ${baseIndex}`);
  });
  const similarities = candidates.flatMap((left, index) => candidates.slice(index + 1)
    .map(right => contourSimilarity(left.descriptor, right.descriptor, row => row >= 8 && row < 22)));
  assert.equal(new Set(candidates.map(candidate => candidate.baseFamily)).size, 5);
  assert.ok(similarities.reduce((sum, value) => sum + value, 0) / similarities.length <= 0.75,
    JSON.stringify(similarities));
  assert.ok(Math.max(...similarities) <= 0.86, JSON.stringify(similarities));
});

test('the same layer template is never stacked more than twice in succession', () => {
  const candidate = buildGeneratedCandidate({
    seed: 'repeated-module-repro', attempt: 0, familyIndex: 2, number: 111,
    platformType: 'single-5', assets, shiftFamilyOnRetry: false,
    budgetExponent: 3, preserveParallelRatio: 0.35, terminationRatio: 0.75,
    adaptiveConnections: true, wideStructuralFallback: true, randomizeCross: true,
  });
  const operationsByLayer = Object.groupBy(candidate.rewriteLog, entry => entry.layer);
  const longestRun = Object.values(operationsByLayer).slice(1).reduce((state, entries) => {
    const template = entries.map(entry => entry.operation).join('|');
    const current = template === state.previous ? state.current + 1 : 1;
    return { previous: template, current, longest: Math.max(state.longest, current) };
  }, { previous: '', current: 0, longest: 0 }).longest;
  assert.ok(longestRun <= 2, JSON.stringify(operationsByLayer));
});

test('20-request real-runtime batch meets the v3 minimum and full quality gates', { timeout: 100_000 }, async () => {
  const batch = await generateLevelBatch({
    seed: 'acceptance-matrix', targetCount: 20, config, assets, existingLevels: [],
    validateStability: validateLevelStability, yieldControl: async () => {},
  });
  assert.ok(batch.candidates.length >= 15, JSON.stringify(batch.diagnostics.rejected));
  const signatures = new Set();
  for (const candidate of batch.candidates) {
    const checked = validateGeneratedCandidate(candidate, { assets, knownSignatures: signatures });
    assert.equal(checked.ok, true, `${candidate.platformType}/${candidate.family}: ${checked.reason}`);
    assert.ok(candidate.level.castle.length >= 70 && candidate.level.castle.length <= 100);
    assert.ok(checked.metrics.counts.glass <= Math.floor(candidate.level.castle.length * 0.1));
    assert.ok(checked.metrics.woodRatio >= 0.23 && checked.metrics.woodRatio <= 0.27);
    assert.ok(checked.metrics.counts.stone + checked.metrics.counts.metal >= Math.ceil(candidate.level.castle.length * 0.6));
    assert.deepEqual(Object.keys(checked.metrics.counts).sort(), ['glass', 'metal', 'rubber', 'stone', 'wood']);
    assert.equal(candidate.stability.ok, true);
    assert.ok(candidate.descriptor.nodes.every(node => node.depth > 0 && node.rootRegions.length > 0));
    if (candidate.platformType.startsWith('double-')) assert.ok(candidate.descriptor.topology.crossPlatformNodes > 0);
    signatures.add(checked.signature);
    for (const [childId, parents] of candidate.supports) {
      assert.equal(parents.length === 1 && parents[0].materialId === 'rubber', false, `${childId} has sole rubber support`);
    }
  }
  assert.equal(signatures.size, batch.candidates.length);
  assert.deepEqual(new Set(batch.candidates.map(candidate => candidate.platformType)), new Set(['single-3', 'single-5', 'double-2', 'double-3']));
  const platformCounts = Object.values(Object.groupBy(batch.candidates, candidate => candidate.platformType)).map(group => group.length);
  assert.ok(Math.max(...platformCounts) <= batch.candidates.length / 2);
  const topologyCounts = Object.values(Object.groupBy(batch.candidates, candidate => candidate.family)).map(group => group.length);
  assert.ok(topologyCounts.length >= 8);
  assert.ok(Math.max(...topologyCounts) <= 3);
});

test('20-request batch retries a platform after a transient physics failure', { timeout: 100_000 }, async () => {
  const batch = await generateLevelBatch({
    seed: '1sch968-1jha53n', targetCount: 20, config, assets, existingLevels: historicalLevels,
    validateStability: validateLevelStability, yieldControl: async () => {}, maxAttempts: 400,
  });
  assert.equal(batch.insufficient, false, JSON.stringify(batch.diagnostics));
  assert.ok(batch.candidates.length >= 15, JSON.stringify(batch.diagnostics));
});

test('20-request batch does not exhaust macro families before the caller attempt limit', { timeout: 40_000 }, async () => {
  const batch = await generateLevelBatch({
    seed: '1a9tkhu-1npq19t', targetCount: 20, config, assets, existingLevels: historicalLevels,
    validateStability: async () => ({ ok: true }), yieldControl: async () => {}, maxAttempts: 400,
  });
  assert.equal(batch.diagnostics.attempted, 400, JSON.stringify(batch.diagnostics));
  assert.ok(batch.candidates.length > 1, JSON.stringify(batch.diagnostics));
});

test('a second 20-request batch escapes normalized foundations in recent generated history', { timeout: 40_000 }, async () => {
  const batch = await generateLevelBatch({
    seed: 'tusnzy-nqaqjk', targetCount: 20, config, assets, existingLevels: historicalLevels,
    validateStability: async () => ({ ok: true }), maxAttempts: 400, yieldControl: async () => {},
  });
  assert.equal(batch.insufficient, false, JSON.stringify(batch.diagnostics));
  assert.equal(batch.candidates.length, 20, JSON.stringify(batch.diagnostics));
  assert.equal(batch.diagnostics.crossBatchPool.selectionSatisfied, true);
  assert.ok(batch.diagnostics.crossBatchPool.candidates < 80, JSON.stringify(batch.diagnostics));
});

test('generated and final-JSON validation cap glass at floor ten percent', () => {
  const candidate = buildFixture({ seed: 'glass-cap', number: 101, platformType: 'single-5' });
  const count = candidate.level.castle.length;
  const glass = candidate.level.castle.filter(object => object.materialId === 'glass').length;
  assert.ok(glass <= Math.floor(count * 0.1), `${glass}/${count}`);
  const forged = structuredClone(candidate);
  for (const object of forged.level.castle.filter(object => object.materialId !== 'glass').slice(0, Math.floor(count * 0.1) + 1 - glass)) object.materialId = 'glass';
  assert.equal(validateGeneratedCandidate(forged, { assets }).reason, 'material');
});

test('generated material balance centers wood at twenty-five percent and reinforces the body on every platform', t => {
  const evidence = {};
  for (const [index, platformType] of ['single-3', 'single-5', 'double-2', 'double-3'].entries()) {
    const fixture = { seed: `material-balance-v3-${platformType}`, number: 101 + index, platformType };
    const candidate = buildFixture(fixture);
    const total = candidate.level.castle.length;
    const counts = Object.fromEntries(['wood', 'glass', 'stone', 'metal', 'rubber'].map(material => [
      material, candidate.level.castle.filter(object => object.materialId === material).length,
    ]));
    const woodRatio = counts.wood / total;
    assert.ok(woodRatio >= 0.23 && woodRatio <= 0.27, `${platformType}: ${counts.wood}/${total}`);
    assert.ok(counts.stone + counts.metal >= Math.ceil(total * 0.6), `${platformType}: reinforced ${counts.stone + counts.metal}/${total}`);
    assert.ok(counts.glass >= 7 && counts.glass <= Math.floor(total * 0.10), `${platformType}: glass ${counts.glass}/${total}`);
    assert.ok(Object.values(counts).every(Boolean), `${platformType}: ${JSON.stringify(counts)}`);
    evidence[platformType] = { total, ...counts, woodRatio: Number(woodRatio.toFixed(3)) };
    if (index === 0) {
      const replay = buildFixture(fixture);
      const structure = value => ({
        objects: value.level.castle.map(({ materialId, ...object }) => object),
        supports: [...value.supports].map(([id, parents]) => [id, parents.map(parent => parent.id)]),
        rewriteLog: value.rewriteLog,
      });
      assert.deepEqual(structure(replay), structure(candidate));
    }
  }
  t.diagnostic(JSON.stringify(evidence));
});

test('the main body merges or crosses into a horizontal band before 82 percent of the budget', () => {
  const candidate = buildGeneratedCandidate({
    seed: 'lefxjm-h40eww', attempt: 6, number: 101, platformType: 'single-3', familyIndex: 6, assets,
  });
  const checked = validateGeneratedCandidate(candidate, { assets });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const horizontalBand = candidate.rewriteLog.find(entry => ['merge', 'cross'].includes(entry.operation)
    && entry.beforeCount / candidate.level.castle.length < 0.82);
  assert.ok(horizontalBand, JSON.stringify(candidate.rewriteLog));
});

test('generated batches use non-rectangular structural shapes', async () => {
  const batch = await generateLevelBatch({
    seed: 'shape-variety-repro', targetCount: 5, config, assets, existingLevels: [],
    validateStability: async () => ({ ok: true }), yieldControl: async () => {},
  });
  assert.equal(batch.candidates.length, 5, JSON.stringify(batch.diagnostics.rejected));
  assert.ok(batch.candidates.every(candidate => candidate.level.castle.length >= 70 && candidate.level.castle.length <= 100));
  assert.ok(batch.candidates.every(candidate => candidate.level.castle.some(object => {
    const node = candidate.descriptor.nodes.find(entry => entry.id === object.id);
    return object.shape.kind !== 'box' && (node.parentIds.length || node.rootRegions.length);
  })));
  const kinds = new Set(batch.candidates.flatMap(candidate => candidate.level.castle.map(object => object.shape.kind)));
  assert.ok(kinds.has('circle'));
  assert.ok(kinds.has('polygon'));
});

test('v3 adaptively covers platforms and preserves an insufficient qualified prefix', async () => {
  assert.equal(GENERATOR_VERSION, 3);
  const selectedForPhysics = [];
  const acceptedPlatforms = new Set();
  let adaptiveFailure;
  let adaptiveFailureIndex;
  const adaptive = await generateLevelBatch({
    seed: 'adaptive-platform-v3', targetCount: 5, config, assets, existingLevels: [], maxAttempts: 200,
    validateStability: async level => {
      selectedForPhysics.push(level.platformType);
      if (acceptedPlatforms.size === 4 && !adaptiveFailure) {
        adaptiveFailure = level.platformType;
        adaptiveFailureIndex = selectedForPhysics.length - 1;
        return { ok: false, reason: 'displacement' };
      }
      acceptedPlatforms.add(level.platformType);
      return { ok: true };
    },
    yieldControl: async () => {},
  });
  assert.equal(adaptive.candidates.length, 5, JSON.stringify(adaptive.diagnostics));
  assert.equal(new Set(adaptive.candidates.slice(0, 4).map(candidate => candidate.platformType)).size, 4,
    JSON.stringify(adaptive.candidates.map(candidate => candidate.platformType)));
  assert.equal(adaptive.diagnostics.rejected.displacement, 1);
  assert.ok(selectedForPhysics.length > adaptiveFailureIndex + 1);
  assert.ok(Object.values(adaptive.diagnostics.platforms).every(platform => platform.attempted > 0));
  assert.ok(Math.max(...Object.values(adaptive.diagnostics.platforms).map(value => value.accepted)) <= adaptive.candidates.length / 2);

  const localAttempts = await generateLevelBatch({
    seed: 'lefxjm-h40eww', targetCount: 5, config, assets, existingLevels: [], maxAttempts: 80,
    validateStability: async () => ({ ok: true }), yieldControl: async () => {},
  });
  assert.equal(localAttempts.candidates.length, 5, JSON.stringify(localAttempts.diagnostics));
  assert.equal(new Set(localAttempts.candidates.map(candidate => candidate.platformType)).size, 4);
  assert.ok(Object.values(localAttempts.diagnostics.platforms).every(platform => platform.attempted > 0));

  let accepted = 0;
  const insufficient = await generateLevelBatch({
    seed: 'insufficient-prefix-v3', targetCount: 5, config, assets, existingLevels: [], maxAttempts: 40,
    validateStability: async () => ++accepted <= 3 ? { ok: true } : { ok: false, reason: 'displacement' },
    yieldControl: async () => {},
  });
  assert.equal(insufficient.candidates.length, 3);
  assert.equal(insufficient.diagnostics.accepted, 3);
  assert.equal(insufficient.insufficient, true);
  assert.equal(insufficient.diagnostics.insufficient, true);
  assert.equal(insufficient.diagnostics.shortfall.minimumAccepted, 4);
});

test('all platforms satisfy the architectural cohesion gates', () => {
  for (const [index, platformType] of ['single-3', 'single-5', 'double-2', 'double-3'].entries()) {
    const candidate = buildFixture({ seed: `architectural-cohesion-${platformType}`, number: 101 + index, platformType });
    assert.ok(candidate.descriptor.architecture.foundationContinuity >= 0.62, `${platformType}: foundation continuity`);
    assert.ok(candidate.descriptor.architecture.majorBandCount >= 2, `${platformType}: major bands`);
    assert.ok(candidate.descriptor.architecture.lowerCohesion >= 0.30, `${platformType}: lower cohesion`);
    assert.ok(candidate.descriptor.architecture.maxDensePostRun <= 2, `${platformType}: dense post run`);
  }
});

test('batch generation is deterministic and yields between candidates', async () => {
  const options = { seed: 'repeatable', targetCount: 10, config, assets, existingLevels: [], validateStability: async () => ({ ok: true }), yieldControl: async () => {} };
  const first = await generateLevelBatch(options);
  const second = await generateLevelBatch(options);
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(first.diagnostics.rejected, second.diagnostics.rejected);
  assert.ok(first.candidates.length >= 8);
  assert.equal(first.insufficient, false);
  assert.equal(first.diagnostics.crossBatchPool.selectionSatisfied, true);
  assert.ok(new Set(first.candidates.map(candidate => candidate.family)).size >= 6);
});

test('seed changes candidate topology signatures rather than only ordering', async () => {
  const options = { targetCount: 5, config, assets, existingLevels: [], validateStability: async () => ({ ok: true }), yieldControl: async () => {} };
  const first = await generateLevelBatch({ ...options, seed: 'alpha' });
  const second = await generateLevelBatch({ ...options, seed: 'beta' });
  assert.notDeepEqual(first.candidates.map(candidate => `${candidate.platformType}/${candidate.family}`), second.candidates.map(candidate => `${candidate.platformType}/${candidate.family}`));
  assert.notDeepEqual(new Set(first.candidates.map(candidate => candidate.signature)), new Set(second.candidates.map(candidate => candidate.signature)));
});

test('history rarity weights and final JSON expose cross-layer and cantilever operations', async () => {
  const common = reconstruct => ({ topology: { forks: 0, merges: 0, openings: 0, crossLayerConnections: 0 }, complexity: { offsetChanges: 0, widthChanges: 0, terminalDepths: [], ...reconstruct } });
  const weights = historicalRarityWeights([common({ offsetChanges: 2 }), common({ offsetChanges: 1 })]);
  assert.equal(weights.step, 1 / 3);
  assert.equal(weights.cross, 1);
  const batch = await generateLevelBatch({
    seed: 'operation-audit-v2', targetCount: 20, config, assets, existingLevels: [],
    validateStability: async () => ({ ok: true }), yieldControl: async () => {},
  });
  assert.ok(batch.candidates.some(candidate => candidate.descriptor.topology.crossLayerConnections > 0));
  assert.ok(batch.candidates.some(candidate => candidate.rewriteLog.some(entry => entry.operation === 'step') && candidate.descriptor.complexity.offsetChanges > 0));
});

test('a second seed still supplies five real-runtime candidates after accepting a complete 20-level batch', { timeout: 190_000 }, async () => {
  const common = { config, assets, validateStability: validateLevelStability, yieldControl: async () => {} };
  const first = await generateLevelBatch({ ...common, seed: 'library-seed-a', targetCount: 20 });
  assert.ok(first.candidates.length >= 15, JSON.stringify(first.diagnostics));
  const second = await generateLevelBatch({
    ...common, seed: 'library-seed-b', targetCount: 5, existingLevels: first.candidates.map(candidate => candidate.level),
  });
  assert.ok(second.candidates.length >= 4, JSON.stringify(second.diagnostics));
  const accepted = new Set(first.candidates.map(candidate => candidate.signature));
  assert.ok(second.candidates.every(candidate => !accepted.has(candidate.signature)));
});

test('static validation rejects rubber as the sole support of an upper object', () => {
  const candidate = buildFixture({ seed: 'rubber-parent', number: 101, platformType: 'single-3' });
  const relation = [...candidate.supports.entries()].find(([, parents]) => parents.length === 1);
  assert.ok(relation);
  relation[1][0].materialId = 'rubber';
  const checked = validateGeneratedCandidate(candidate, { assets });
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'support');
  assert.equal(checked.details.code, 'sole-rubber-support');
});

test('historical duplicates are skipped without stalling the remaining batch', async () => {
  const options = { seed: 'history', targetCount: 5, config, assets, validateStability: async () => ({ ok: true }), yieldControl: async () => {} };
  const first = await generateLevelBatch({ ...options, existingLevels: [] });
  assert.equal(first.candidates[0].suggestedNumber, 100);
  const second = await generateLevelBatch({ ...options, existingLevels: [first.candidates[0].level] });
  assert.equal(second.candidates.length, 5);
  assert.ok((second.diagnostics.rejected.duplicate ?? 0) >= 1);
  assert.ok(second.candidates.every(candidate => candidate.signature !== first.candidates[0].signature));
});

test('the complete manifest history participates in numbering and signature checks', async () => {
  assert.equal(historicalLevels.length, manifest.levels.length);
  const result = await generateLevelBatch({
    seed: 'official-history', targetCount: 5, config, assets, existingLevels: historicalLevels,
    validateStability: async () => ({ ok: true }), yieldControl: async () => {},
  });
  assert.equal(result.candidates.length, 5, JSON.stringify(result.diagnostics.rejected));
  assert.equal(result.candidates[0].suggestedNumber, Math.max(...manifest.levels.map(entry => Number(entry.number))) + 1);
});

test('real-runtime batches meet 5, 10 and 20 candidate performance limits', { timeout: 150_000 }, async () => {
  for (const [targetCount, limit] of [[5, 15_000], [10, 30_000], [20, 90_000]]) {
    const result = await generateLevelBatch({ seed: `benchmark-${targetCount}`, targetCount, config, assets, existingLevels: [], validateStability: validateLevelStability });
    assert.ok(result.candidates.length >= ({ 5: 4, 10: 8, 20: 15 })[targetCount], `${targetCount}: ${JSON.stringify(result.diagnostics.rejected)}`);
    assert.ok(result.diagnostics.elapsedMs < limit, `${targetCount} took ${result.diagnostics.elapsedMs}ms`);
    const platformCounts = Object.values(Object.groupBy(result.candidates, candidate => candidate.platformType)).map(group => group.length);
    const familyCounts = Object.values(Object.groupBy(result.candidates, candidate => candidate.family)).map(group => group.length);
    const minimumCategories = targetCount === 5 ? 4 : targetCount === 10 ? 6 : 8;
    const maximumCategory = targetCount === 20 ? 3 : 2;
    assert.equal(platformCounts.length, 4);
    assert.ok(Math.max(...platformCounts) <= result.candidates.length / 2);
    assert.ok(familyCounts.length >= minimumCategories);
    assert.ok(Math.max(...familyCounts) <= maximumCategory);
  }
});

test('mirror, translation, material changes, scaling and small spacing changes deduplicate', () => {
  const source = buildGeneratedCandidate({ seed: 'signature', attempt: 0, number: 101, platformType: 'single-5', familyIndex: 0, assets }).level;
  const descriptor = reconstructLevelStructure(source, assets);
  const variants = [
    { ...structuredClone(source), castle: source.castle.map(object => ({ ...object, x: 9 - object.x, angle: -object.angle })) },
    { ...structuredClone(source), castle: source.castle.map(object => ({ ...object, x: object.x + 0.3, y: object.y - 0.2 })) },
    { ...structuredClone(source), castle: source.castle.map(object => ({ ...object, materialId: object.materialId === 'wood' ? 'glass' : 'wood' })) },
    { ...structuredClone(source), castle: source.castle.map(object => ({ ...object, x: 4.5 + (object.x - 4.5) * 1.02, y: 12.34 + (object.y - 12.34) * 1.02 })) },
    { ...structuredClone(source), castle: source.castle.map((object, index) => ({ ...object, x: object.x + (index % 2 ? 0.004 : -0.004) })) },
  ];
  for (const variant of variants) assert.equal(isNearDuplicate(descriptor, reconstructLevelStructure(variant, assets)).duplicate, true);
});

test('signatures include inferred support topology and opening contour summaries', () => {
  const source = buildFixture({ seed: 'structural-signature', number: 101, platformType: 'single-3' }).level;
  const supportChanged = structuredClone(source);
  const upper = supportChanged.castle.find(object => object.y < 11 && object.shapePresetId === 'small-square');
  upper.y -= 0.12;
  const contourChanged = structuredClone(source);
  const roof = contourChanged.castle.find(object => object.y < 10 && ['small-square', 'square'].includes(object.shapePresetId));
  roof.x += 0.45;
  assert.notEqual(structureSignature(reconstructLevelStructure(supportChanged, assets)), structureSignature(reconstructLevelStructure(source, assets)));
  assert.notEqual(structureSignature(reconstructLevelStructure(contourChanged, assets)), structureSignature(reconstructLevelStructure(source, assets)));
});

test('number reservation only moves forward and updates generated identity', () => {
  const candidates = [101, 102].map(number => buildFixture({ seed: 'numbers', number, platformType: 'single-5' }));
  const occupiedPath = `level/${exportedLevelFilename({ number: 102, name: candidates[0].level.levelName })}`;
  const reserved = reserveCandidateNumbers(candidates, new Set([94, 101, 103]), new Set([occupiedPath]));
  assert.deepEqual(reserved.map(candidate => candidate.suggestedNumber), [104, 105]);
  assert.deepEqual(reserved.map(candidate => candidate.level.__levelDocument.levelId), ['level-104', 'level-105']);
  assert.deepEqual(reserved.map(candidate => candidate.fileName), reserved.map(candidate => exportedLevelFilename({
    number: candidate.suggestedNumber,
    name: candidate.level.levelName,
  })));
  assert.deepEqual(reserved.map(candidate => candidate.filePath), reserved.map(candidate => `level/${candidate.fileName}`));
  assert.ok(reserved[0].level.castle.every(object => object.id.startsWith('generated-104-')));
});

test('cancellation keeps completed candidates and stops boundedly', async () => {
  const controller = new AbortController();
  let validations = 0;
  const result = await generateLevelBatch({
    seed: 'cancel', targetCount: 5, config, assets, signal: controller.signal,
    validateStability: async () => { validations += 1; controller.abort(); return { ok: true }; },
    yieldControl: async () => {},
  });
  assert.equal(validations, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.diagnostics.rejected.cancelled, 1);
});

test('20-level cancellation preserves the qualified pool before subset selection', { timeout: 30_000 }, async () => {
  const controller = new AbortController();
  const result = await generateLevelBatch({
    seed: 'cancel-subset-v3', targetCount: 20, config, assets, existingLevels: [], signal: controller.signal,
    validateStability: async () => ({ ok: true }),
    onProgress: progress => { if (progress.accepted >= 1) controller.abort(); },
    yieldControl: async () => {},
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.diagnostics.crossBatchPool.candidates, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.accepted, 1);
});

test('an incomplete 20-level run returns its qualified pool instead of clearing it', async () => {
  const result = await generateLevelBatch({
    seed: 'cancel-subset-v3', targetCount: 20, config, assets, existingLevels: [], maxAttempts: 1,
    validateStability: async () => ({ ok: true }), yieldControl: async () => {},
  });
  assert.equal(result.diagnostics.crossBatchPool.candidates, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.accepted, 1);
  assert.equal(result.insufficient, true);
});

test('production defaults have no attempt or duration ceiling and still obey manual cancellation', { timeout: 30_000 }, async () => {
  const attemptsController = new AbortController();
  const attemptsResult = await generateLevelBatch({
    seed: 'unbounded-attempts', targetCount: 5, config, assets, signal: attemptsController.signal,
    validateStability: async () => ({ ok: false, reason: 'displacement' }),
    onProgress: progress => { if (progress.attempted > 600) attemptsController.abort(); },
    yieldControl: async () => {},
  });
  assert.ok(attemptsResult.diagnostics.attempted > 600);
  assert.equal(attemptsResult.cancelled, true);
  assert.equal(attemptsResult.diagnostics.rejected.attempts, undefined);

  const originalPerformance = globalThis.performance;
  const durationController = new AbortController();
  let clockReads = 0;
  globalThis.performance = { now: () => clockReads++ ? 100_000 : 0 };
  try {
    const durationResult = await generateLevelBatch({
      seed: 'unbounded-duration', targetCount: 5, config, assets, signal: durationController.signal,
      validateStability: async () => ({ ok: false, reason: 'displacement' }),
      onProgress: () => durationController.abort(), yieldControl: async () => {},
    });
    assert.ok(durationResult.diagnostics.attempted > 0);
    assert.equal(durationResult.cancelled, true);
    assert.equal(durationResult.diagnostics.rejected.performance, undefined);
  } finally {
    globalThis.performance = originalPerformance;
  }
});

test('stability validation disposes on cancellation and runtime failure', async () => {
  for (const mode of ['cancel', 'failure']) {
    let disposed = 0;
    const controller = new AbortController();
    if (mode === 'cancel') controller.abort();
    const result = await validateLevelStability({ castle: [] }, {
      signal: controller.signal,
      createRuntime: () => ({
        snapshot: () => ({ bodies: [], remainingTargets: 0 }),
        step: () => { throw new Error('boom'); },
        dispose: () => { disposed += 1; },
      }),
    });
    assert.equal(result.reason, mode === 'cancel' ? 'cancelled' : 'runtime');
    assert.equal(disposed, 1);
  }
});

test('stability validation observes a timer-driven abort inside a running candidate', async () => {
  const controller = new AbortController();
  let disposed = 0;
  let steps = 0;
  const body = { id: 'moving', x: 4.5, y: 10, angle: 0, vx: 1, vy: 0, angularVelocity: 0, hp: 10 };
  const level = { castle: [{ ...body, materialId: 'wood', shape: { kind: 'box', width: 0.4, height: 0.4 } }] };
  setTimeout(() => controller.abort(), 0);
  const result = await validateLevelStability(level, {
    signal: controller.signal,
    yieldEverySteps: 4,
    createRuntime: () => ({
      snapshot: () => ({ bodies: [body], remainingTargets: 1 }),
      step: () => { steps += 1; return { bodies: [body], remainingTargets: 1 }; },
      dispose: () => { disposed += 1; },
    }),
  });
  assert.equal(result.reason, 'cancelled');
  assert.ok(steps >= 4 && steps < 480, `cancelled after ${steps} steps`);
  assert.equal(disposed, 1);
});
