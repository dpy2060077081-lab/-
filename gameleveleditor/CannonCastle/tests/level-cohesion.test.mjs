import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildGeneratedCandidate, generateLevelBatch, validateGeneratedCandidate } from '../static/js/batch-level-generator.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import { reconstructLevelStructure } from '../static/js/level-structure.js';

const { config, assets } = decodeGlobalConfig(JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8')));

const object = (id, shapePresetId, x, y) => ({
  id, x, y, angle: 0, materialId: 'stone', shapePresetId, shape: structuredClone(assets.shapes[shapePresetId].shape),
});

function componentSizes(nodes) {
  const neighbors = new Map(nodes.map(node => [node.id, new Set()]));
  for (const node of nodes) for (const parentId of node.parentIds) {
    neighbors.get(node.id)?.add(parentId);
    neighbors.get(parentId)?.add(node.id);
  }
  const remaining = new Set(neighbors.keys());
  const sizes = [];
  while (remaining.size) {
    const queue = [remaining.values().next().value];
    remaining.delete(queue[0]);
    let size = 0;
    while (queue.length) {
      const id = queue.pop();
      size += 1;
      for (const neighbor of neighbors.get(id)) if (remaining.delete(neighbor)) queue.push(neighbor);
    }
    sizes.push(size);
  }
  return sizes.sort((left, right) => right - left);
}

test('cohesion repro forms one non-platform support component', () => {
  const candidate = buildGeneratedCandidate({
    seed: 'cohesion-repro', attempt: 0, number: 101, platformType: 'double-3', familyIndex: 0, assets,
  });
  const sizes = componentSizes(candidate.descriptor.nodes);
  console.log('COHESION_FAST_FEEDBACK', JSON.stringify({ objects: candidate.level.castle.length, components: sizes.length, sizes }));
  assert.equal(sizes.length, 1, `detached components: ${JSON.stringify(sizes)}`);
});

test('final JSON distinguishes separated towers from a real upper bridge', () => {
  const detached = reconstructLevelStructure({ platformType: 'single-5', castle: [
    object('left', 'square', 3, 12.09), object('right', 'square', 6, 12.09),
  ] }, assets);
  assert.equal(detached.connectedComponentCount, 2);
  assert.deepEqual(detached.detachedComponentSizes, [1]);
  assert.equal(detached.largestComponentRatio, 0.5);

  const bridgedLevel = { platformType: 'single-5', castle: [
    object('left', 'square', 4.2, 12.09), object('right', 'square', 4.8, 12.09),
    object('bridge', 'long-thin-rectangle', 4.5, 11.72),
  ] };
  const bridged = reconstructLevelStructure(bridgedLevel, assets);
  assert.equal(bridged.connectedComponentCount, 1);
  assert.equal(bridged.largestComponentRatio, 1);
  assert.deepEqual(bridged.detachedComponentSizes, []);
});

test('validator rejects a detached non-platform support graph explicitly', () => {
  const level = { platformType: 'single-5', castle: [
    object('left', 'square', 3, 12.09), object('right', 'square', 6, 12.09),
  ] };
  const result = validateGeneratedCandidate({ level }, { assets });
  assert.equal(result.reason, 'support');
  assert.equal(result.details.code, 'detached-structure');
  assert.equal(result.details.connectedComponentCount, 2);
});

test('five-level mock batch keeps every final support graph cohesive', async () => {
  const batch = await generateLevelBatch({
    seed: 'cohesion-mock-batch', targetCount: 5, config, assets, existingLevels: [], maxAttempts: 200,
    validateStability: async () => ({ ok: true }), yieldControl: async () => {},
  });
  assert.ok(batch.candidates.length >= 4, JSON.stringify(batch.diagnostics));
  for (const candidate of batch.candidates) {
    const descriptor = reconstructLevelStructure(candidate.level, assets);
    assert.equal(descriptor.connectedComponentCount, 1, `level ${candidate.level.levelNumber}`);
    assert.ok(descriptor.rootPathCount >= 2, `level ${candidate.level.levelNumber} lost its vertical masses`);
    assert.ok(descriptor.topology.openings >= 1, `level ${candidate.level.levelNumber} lost its opening`);
  }
});

