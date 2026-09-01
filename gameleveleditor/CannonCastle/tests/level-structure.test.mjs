import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildGeneratedCandidate, MAX_DIRECT_SUPPORT_EMBED, validateGeneratedCandidate } from '../static/js/batch-level-generator.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import { decodeLevelDocument, encodeLevelDocument } from '../static/js/level-document.js';
import { objectBounds } from '../static/js/placement-collision.js';
import {
  compareStructureDescriptors, isNearDuplicate, jaccard, layerVectorSimilarity,
  reconstructLevelStructure, structureSignature, STRUCTURE_DESCRIPTOR_VERSION,
} from '../static/js/level-structure.js';

const globalDocument = JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8'));
const { assets } = decodeGlobalConfig(globalDocument);
const candidate = () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { return buildGeneratedCandidate({ seed: 'structure-v2', attempt, number: 101, platformType: 'single-5', familyIndex: attempt, assets }).level; } catch {}
  }
  throw new Error('no constructible structure fixture');
};

function variant(level, update) {
  const next = structuredClone(level);
  next.castle = next.castle.map(update);
  return next;
}

test('final JSON reconstruction is invariant to ids, material, mirror, translation, scale and micro jitter', () => {
  const source = candidate();
  const descriptor = reconstructLevelStructure(source, assets);
  const variants = [
    variant(source, (object, index) => ({ ...object, id: `other-${index}`, materialId: index % 2 ? 'glass' : 'wood' })),
    variant(source, object => ({ ...object, x: 9 - object.x, angle: -object.angle })),
    variant(source, object => ({ ...object, x: object.x + 0.31, y: object.y - 0.23 })),
    variant(source, object => ({ ...object, x: 4.5 + (object.x - 4.5) * 1.02, y: 12.34 + (object.y - 12.34) * 1.02 })),
    variant(source, (object, index) => ({ ...object, x: object.x + (index % 2 ? 0.004 : -0.004) })),
  ];
  for (const changed of variants) {
    const rebuilt = reconstructLevelStructure(changed, assets);
    const comparison = compareStructureDescriptors(descriptor, rebuilt);
    assert.equal(rebuilt.version, STRUCTURE_DESCRIPTOR_VERSION);
    assert.equal(isNearDuplicate(descriptor, rebuilt).duplicate, true);
    assert.ok(comparison.contourJaccard > 0.8, JSON.stringify(comparison));
  }
});

test('v2 encode, JSON save and reload reconstruct the same structural facts', () => {
  const source = candidate();
  const before = reconstructLevelStructure(source, assets);
  const reloaded = decodeLevelDocument(JSON.parse(JSON.stringify(encodeLevelDocument(source))), assets);
  const after = reconstructLevelStructure(reloaded, assets);
  assert.equal(structureSignature(after), structureSignature(before));
  assert.equal(after.topologyKey, before.topologyKey);
  assert.deepEqual([...after.contour].sort(), [...before.contour].sort());
  assert.deepEqual([...after.whitespace].sort(), [...before.whitespace].sort());
  assert.deepEqual(after.layerVector, before.layerVector);
});

test('multi-axis duplicate thresholds are strict at their documented boundaries', () => {
  const descriptor = ({ contour, whitespace, supportSignature = 'a', layer = 0 }) => ({
    contour: new Set(contour), whitespace: new Set(whitespace), supportSignature,
    layerVector: [[[layer, 0, 0, 0, 0, 0, 0, 0]]].flat(),
  });
  const lowLayer = Array(8).fill(0);
  const highLayer = Array(8).fill(1);
  const make = ({ contour, whitespace, signature = 'a', vector = lowLayer }) => ({ contour: new Set(contour), whitespace: new Set(whitespace), supportSignature: signature, layerVector: [vector] });

  const contourBase = make({ contour: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], whitespace: [], signature: 'a', vector: lowLayer });
  const contourBoundary = make({ contour: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'j'], whitespace: [], signature: 'b', vector: highLayer });
  const contourAbove = make({ contour: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], whitespace: [], signature: 'b', vector: highLayer });
  assert.equal(jaccard(contourBase.contour, contourBoundary.contour), 0.8);
  assert.equal(isNearDuplicate(contourBase, contourBoundary).duplicate, false);
  assert.equal(isNearDuplicate(contourBase, contourAbove).duplicate, true);

  const whitespaceBase = make({ contour: ['a'], whitespace: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], signature: 'same', vector: lowLayer });
  const whitespaceBoundary = make({ contour: ['b'], whitespace: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], signature: 'same', vector: highLayer });
  const whitespaceAbove = make({ contour: ['b'], whitespace: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], signature: 'same', vector: highLayer });
  assert.equal(jaccard(whitespaceBase.whitespace, whitespaceBoundary.whitespace), 0.7);
  assert.equal(isNearDuplicate(whitespaceBase, whitespaceBoundary).duplicate, false);
  assert.equal(isNearDuplicate(whitespaceBase, whitespaceAbove).duplicate, true);

  const layerBase = make({ contour: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], whitespace: [], signature: 'a', vector: lowLayer });
  const layerBoundary = make({ contour: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], whitespace: [], signature: 'b', vector: Array(8).fill(0.1) });
  const layerAbove = make({ contour: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], whitespace: [], signature: 'b', vector: Array(8).fill(0.09) });
  assert.ok(Math.abs(layerVectorSimilarity(layerBase.layerVector, layerBoundary.layerVector) - 0.9) < 1e-12);
  assert.equal(isNearDuplicate(layerBase, layerBoundary).duplicate, false);
  assert.equal(isNearDuplicate(layerBase, layerAbove).duplicate, true);
});

test('real support and contour changes alter reconstructed structure', () => {
  const source = candidate();
  const before = reconstructLevelStructure(source, assets);
  const changed = structuredClone(source);
  const upper = changed.castle.find(object => object.y < 10.5 && object.shapePresetId === 'rectangle');
  upper.x += 0.45;
  upper.y -= 0.12;
  const after = reconstructLevelStructure(changed, assets);
  assert.notEqual(after.supportSignature, before.supportSignature);
  assert.ok(compareStructureDescriptors(before, after).contourJaccard < 1);
});

test('final JSON proves complexity without rewriteLog and rejects a forged log', () => {
  let complete;
  for (let attempt = 0; attempt < 60 && !complete; attempt += 1) {
    try { complete = buildGeneratedCandidate({ seed: 'final-evidence', attempt, familyIndex: attempt, number: 101, platformType: 'single-5', assets }); } catch {}
  }
  assert.ok(complete, 'expected a constructible final-evidence fixture');
  const withoutLog = { ...complete };
  delete withoutLog.rewriteLog;
  const rebuilt = validateGeneratedCandidate(withoutLog, { assets });
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.details));
  assert.ok(rebuilt.descriptor.complexity.effectiveRewriteCount >= 12);
  assert.ok(rebuilt.descriptor.complexity.categories.length >= 5);

  const forged = structuredClone(complete);
  forged.rewriteLog[0] = { ...forged.rewriteLog[0], category: 'fabricated' };
  const rejected = validateGeneratedCandidate(forged, { assets });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'complexity');
  assert.equal(rejected.details.code, 'rewrite-evidence-mismatch');

  const repeated = structuredClone(complete);
  repeated.rewriteLog = Array.from({ length: 12 }, () => structuredClone(complete.rewriteLog[0]));
  const repeatedResult = validateGeneratedCandidate(repeated, { assets });
  assert.equal(repeatedResult.ok, false);
  assert.equal(repeatedResult.details.code, 'rewrite-evidence-mismatch');
});

test('platform reachability rejects a lifted castle, a 0.12m gap and a disconnected double platform', () => {
  const constructible = (seed, platformType) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { return buildGeneratedCandidate({ seed, attempt, familyIndex: attempt, number: 101, platformType, assets }); } catch {}
    }
    throw new Error(`no constructible fixture for ${seed}/${platformType}`);
  };
  const complete = constructible('root-adversary', 'single-5');
  delete complete.rewriteLog;
  const lifted = structuredClone(complete);
  lifted.level.castle.forEach(object => { object.y -= 0.5; });
  assert.equal(validateGeneratedCandidate(lifted, { assets }).details.code, 'not-platform-reachable');

  const parentIds = new Set(complete.descriptor.nodes.flatMap(node => node.parentIds));
  let gappedResult = null;
  for (const childNode of complete.descriptor.nodes.filter(node => node.parentIds.length && !parentIds.has(node.id))) {
    const gapped = structuredClone(complete);
    const child = gapped.level.castle.find(object => object.id === childNode.id);
    const parents = childNode.parentIds.map(id => gapped.level.castle.find(object => object.id === id));
    const currentGap = Math.min(...parents.map(parent => objectBounds(parent).minY - objectBounds(child).maxY));
    child.y -= 0.12 - currentGap;
    const result = validateGeneratedCandidate(gapped, { assets });
    if (result.details?.code === 'not-platform-reachable') {
      gappedResult = result;
      break;
    }
  }
  assert.equal(gappedResult?.details.code, 'not-platform-reachable');

  const double = constructible('double-disconnected', 'double-3');
  delete double.rewriteLog;
  const descriptor = reconstructLevelStructure(double.level, assets);
  const retained = new Set(descriptor.nodes.filter(node => node.rootRegions.length === 1).map(node => node.id));
  double.level.castle = double.level.castle.filter(object => retained.has(object.id));
  const retainedDescriptor = reconstructLevelStructure(double.level, assets);
  const retainedParentIds = new Set(retainedDescriptor.nodes.flatMap(node => node.parentIds));
  const rubberIds = new Set(retainedDescriptor.nodes.filter(node => !retainedParentIds.has(node.id)).slice(0, 2).map(node => node.id));
  const nonRubber = double.level.castle.filter(object => !rubberIds.has(object.id));
  double.level.castle.forEach(object => { object.materialId = rubberIds.has(object.id) ? 'rubber' : 'stone'; });
  nonRubber[0].materialId = 'glass';
  nonRubber.slice(1, 21).forEach(object => { object.materialId = 'wood'; });
  nonRubber.slice(21, 24).forEach(object => { object.materialId = 'metal'; });
  const disconnected = validateGeneratedCandidate(double, { assets });
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.details.code, 'detached-structure');
});

test('final JSON rejects fewer than two observable contour changes', () => {
  const insufficient = { level: { platformType: 'single-5', castle: [...Array.from({ length: 80 }, (_, index) => ({
    id: `grid-${index}`, x: 3.75 + (index % 4) * 0.5, y: 12.09 - Math.floor(index / 4) * 0.5,
    angle: 0, materialId: 'stone', shapePresetId: 'square', shape: structuredClone(assets.shapes.square.shape),
  })), {
    id: 'grid-cap', x: 4.5, y: 2.22, angle: 0, materialId: 'stone', shapePresetId: 'long-thin-rectangle',
    shape: structuredClone(assets.shapes['long-thin-rectangle'].shape),
  }] } };
  assert.equal(reconstructLevelStructure(insufficient.level, assets).connectedComponentCount, 1);
  insufficient.level.castle.forEach((object, index) => {
    object.materialId = index === 0 ? 'glass' : index <= 20 ? 'wood' : index <= 23 ? 'metal'
      : index === 76 || index === 80 ? 'rubber' : 'stone';
  });
  assert.ok(reconstructLevelStructure(insufficient.level, assets).complexity.widthChanges < 2);
  const result = validateGeneratedCandidate(insufficient, { assets });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'complexity');
});

test('contour cells use real circle, triangle and rotated geometry instead of AABBs', () => {
  const level = shape => ({ platformType: 'single-3', castle: [{ id: 'shape', x: 4.5, y: 12, angle: 0, materialId: 'wood', shapePresetId: 'custom', shape }] });
  const square = reconstructLevelStructure(level({ kind: 'box', width: 1, height: 1 }), assets);
  const circle = reconstructLevelStructure(level({ kind: 'circle', radius: 0.5 }), assets);
  assert.ok(jaccard(square.contour, circle.contour) < 1);

  const isosceles = reconstructLevelStructure(level({ kind: 'polygon', vertices: [{ x: -0.5, y: 0.5 }, { x: 0, y: -0.5 }, { x: 0.5, y: 0.5 }] }), assets);
  const right = reconstructLevelStructure(level({ kind: 'polygon', vertices: [{ x: -0.5, y: -0.5 }, { x: -0.5, y: 0.5 }, { x: 0.5, y: 0.5 }] }), assets);
  assert.ok(jaccard(isosceles.contour, right.contour) < 1);

  const brace = level({ kind: 'box', width: 1.2, height: 0.2 });
  const flat = reconstructLevelStructure(brace, assets);
  brace.castle[0].angle = Math.PI / 4;
  const angled = reconstructLevelStructure(brace, assets);
  assert.ok(jaccard(flat.contour, angled.contour) < 1);
});

test('only a direct support seam may use the historical 0.03m embed allowance', async () => {
  const historicalDocument = JSON.parse(await readFile(new URL('../level/关卡-002-直射破坏1.json', import.meta.url), 'utf8'));
  const historical = decodeLevelDocument(historicalDocument, assets);
  const lower = historical.castle.find(object => object.id === 'editor-piece-11');
  const upper = historical.castle.find(object => object.id === 'editor-piece-3');
  const historicalEmbed = objectBounds(upper).maxY - objectBounds(lower).minY;
  assert.ok(Math.abs(historicalEmbed - MAX_DIRECT_SUPPORT_EMBED) < 1e-9, historicalEmbed);

  let source;
  for (let attempt = 0; attempt < 60 && !source; attempt += 1) {
    try {
      const built = buildGeneratedCandidate({ seed: 'support-embed', attempt, familyIndex: attempt, number: 101, platformType: 'single-5', assets });
      if (validateGeneratedCandidate(built, { assets }).ok) source = built;
    } catch {}
  }
  assert.ok(source);
  delete source.rewriteLog;
  let node; let gap; let branchIds; let allowed;
  for (const candidateNode of source.descriptor.nodes.filter(entry => entry.parentIds.length === 1)) {
    const parent = source.level.castle.find(object => object.id === candidateNode.parentIds[0]);
    const child = source.level.castle.find(object => object.id === candidateNode.id);
    const candidateGap = objectBounds(parent).minY - objectBounds(child).maxY;
    const candidateBranchIds = new Set([candidateNode.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of source.descriptor.nodes) if (!candidateBranchIds.has(entry.id) && entry.parentIds.some(id => candidateBranchIds.has(id))) {
        candidateBranchIds.add(entry.id);
        changed = true;
      }
    }
    const candidateAllowed = structuredClone(source);
    candidateAllowed.level.castle.filter(object => candidateBranchIds.has(object.id)).forEach(object => { object.y += candidateGap + 0.02; });
    if (validateGeneratedCandidate(candidateAllowed, { assets }).ok) {
      node = candidateNode; gap = candidateGap; branchIds = candidateBranchIds; allowed = candidateAllowed; break;
    }
  }
  assert.ok(node, 'a direct seam fixture should admit the historical embed allowance');
  assert.equal(validateGeneratedCandidate(allowed, { assets }).ok, true);

  const excessive = structuredClone(source);
  excessive.level.castle.filter(object => branchIds.has(object.id)).forEach(object => { object.y += gap + MAX_DIRECT_SUPPORT_EMBED + 0.01; });
  assert.equal(validateGeneratedCandidate(excessive, { assets }).reason, 'overlap');

  const sideways = structuredClone(source);
  const original = sideways.level.castle.at(-1);
  sideways.level.castle.push({ ...original, id: `${original.id}-side-overlap`, x: original.x + objectBounds(original).maxX - objectBounds(original).minX - 0.01 });
  assert.equal(validateGeneratedCandidate(sideways, { assets }).reason, 'overlap');
});

