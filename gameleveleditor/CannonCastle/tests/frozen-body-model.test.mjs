import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFrozenBodies, frozenMembership, expandFrozenSelection, createFrozenBody, removeFrozenBodies } from '../static/js/frozen-body-model.js';
import { assets as productionAssets } from './project-config-fixture.mjs';

const assets = { shapes: { box: { shape: { kind: 'box', width: 1, height: 1 } } } };
const object = (id, x, y, extra = {}) => ({ id, x, y, angle: 0, shapePresetId: 'box', shape: assets.shapes.box.shape, materialId: 'wood', ...extra });
const level = (frozenBodies) => ({ castle: [object('wood-a', 1, 1), object('wood-b', 2, 1), object('wood-c', 6, 1), object('bolt-a', 3, 1, { fixedBolt: true })], frozenBodies });

test('rejects missing, duplicate, overlapping and fixed-bolt frozen members with exact paths', () => {
  const result = validateFrozenBodies(level([
    { id: 'ice-a', memberIds: ['wood-a', 'missing'] },
    { id: 'ice-b', memberIds: ['wood-a', 'bolt-a', 'bolt-a'] },
  ]), assets, { contactTolerance: 0.02 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.ice-a.memberIds.missing'));
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.ice-b.memberIds.wood-a'));
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.ice-b.memberIds.bolt-a'));
});

test('requires one contact-connected component and accepts edge or corner contact', () => {
  assert.equal(validateFrozenBodies(level([{ id: 'ice', memberIds: ['wood-a', 'wood-b'] }]), assets).valid, true);
  assert.equal(validateFrozenBodies(level([{ id: 'ice', memberIds: ['wood-a', 'wood-c'] }]), assets).valid, false);
});

test('accepts a three-object chain with up to one editor grid of space between neighbors', () => {
  const spacedLevel = {
    castle: [object('wood-a', 1, 1), object('wood-b', 2.25, 1), object('wood-c', 3.5, 1)],
    frozenBodies: [{ id: 'ice-spaced-chain', memberIds: ['wood-a', 'wood-b', 'wood-c'] }],
  };

  const result = validateFrozenBodies(spacedLevel, assets);

  assert.equal(result.valid, true, result.errors.map(error => `${error.path}: ${error.message}`).join('\n'));
});

test('rejects objects separated by more than one editor grid', () => {
  const spacedLevel = {
    castle: [object('wood-a', 1, 1), object('wood-b', 2.26, 1)],
    frozenBodies: [{ id: 'ice-too-far', memberIds: ['wood-a', 'wood-b'] }],
  };

  assert.equal(validateFrozenBodies(spacedLevel, assets).valid, false);
});

test('rejects rotated thin objects whose AABBs overlap without real shape contact', () => {
  const thin = { kind: 'box', width: 2, height: 0.2 };
  const rotatedLevel = {
    castle: [
      object('thin-a', 3, 3, { angle: Math.PI / 4, shape: thin }),
      object('thin-b', 3, 4, { angle: Math.PI / 4, shape: thin }),
    ],
    frozenBodies: [{ id: 'ice-thin', memberIds: ['thin-a', 'thin-b'] }],
  };

  const result = validateFrozenBodies(rotatedLevel, assets, { contactTolerance: 0.02 });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.ice-thin.memberIds.thin-b'));
});

test('accepts three rotated objects whose editor bounds form one adjacent chain', () => {
  const thin = { kind: 'box', width: 2, height: 0.2 };
  const adjacentStep = Math.SQRT1_2 * 2.2;
  const adjacentLevel = {
    castle: [
      object('thin-a', 2, 3, { angle: Math.PI / 4, shape: thin }),
      object('thin-b', 2 + adjacentStep, 3, { angle: Math.PI / 4, shape: thin }),
      object('thin-c', 2 + adjacentStep * 2, 3, { angle: Math.PI / 4, shape: thin }),
    ],
    frozenBodies: [{ id: 'ice-thin-chain', memberIds: ['thin-a', 'thin-b', 'thin-c'] }],
  };

  const result = validateFrozenBodies(adjacentLevel, assets, { contactTolerance: 0.02 });

  assert.equal(result.valid, true, result.errors.map(error => `${error.path}: ${error.message}`).join('\n'));
});

test('accepts production rounded rectangles placed at exact corner contact', () => {
  const roundedLevel = {
    castle: [
      { id: 'rounded-a', x: 2, y: 3, angle: 0, shapePresetId: 'rectangle', materialId: 'wood' },
      { id: 'rounded-b', x: 2.82, y: 3.4, angle: 0, shapePresetId: 'rectangle', materialId: 'wood' },
    ],
    frozenBodies: [{ id: 'ice-rounded', memberIds: ['rounded-a', 'rounded-b'] }],
  };

  const result = validateFrozenBodies(roundedLevel, productionAssets, { contactTolerance: 0.02 });

  assert.equal(result.valid, true, result.errors.map(error => `${error.path}: ${error.message}`).join('\n'));
});

test('rejects frozen body ids that collide with castle object ids at the group id path', () => {
  const collision = level([{ id: 'wood-c', memberIds: ['wood-a', 'wood-b'] }]);

  const result = validateFrozenBodies(collision, assets);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.wood-c.id'));
});

test('createFrozenBody skips castle object ids in the shared level namespace', () => {
  const source = {
    castle: [object('frozen-1', 5, 5), object('wood-a', 1, 1), object('wood-b', 2, 1)],
    frozenBodies: [],
  };

  const created = createFrozenBody(source, ['wood-a', 'wood-b']);

  assert.equal(created.frozenBodyId, 'frozen-2');
  assert.equal(source.frozenBodies.length, 0);
});

test('expands selection to complete frozen groups and immutable group operations work', () => {
  const source = level([{ id: 'ice', memberIds: ['wood-a', 'wood-b'] }]);
  assert.deepEqual(expandFrozenSelection(source, ['wood-a']), ['wood-a', 'wood-b']);
  assert.equal(frozenMembership(source).get('wood-b'), 'ice');
  const created = createFrozenBody(level(), ['wood-a', 'wood-b']);
  assert.equal(created.level.frozenBodies.length, 1);
  assert.deepEqual(created.level.frozenBodies[0].memberIds, ['wood-a', 'wood-b']);
  assert.equal(level().frozenBodies, undefined);
  const removed = removeFrozenBodies(created.level, ['wood-a']);
  assert.deepEqual(removed.frozenBodies, []);
});
