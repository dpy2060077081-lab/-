import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssetStore } from '../static/js/asset-store.js';
import { assetCardCommand, createItemInspector, sharedObjectValues } from '../static/js/item-inspector.js';

const assets = {
  materials: {
    wood: { id: 'wood', name: '木头', color: '#abc', mass: 2, friction: 0.5, restitution: 0.4, destructible: true, maxHp: 2, hitSpeedThreshold: 3 },
    stone: { id: 'stone', name: '石头', color: '#999', mass: 7, friction: 0.8, restitution: 0.2, destructible: false, maxHp: 9, hitSpeedThreshold: 6 },
  },
  shapes: { square: { id: 'square', name: '方块', shape: { kind: 'box', width: 1, height: 1 } } },
  specialObjects: {},
};

function editorHarness() {
  const editor = {
    selectedObjectIds: [],
    currentLevel: {
      castle: [
        { id: 'beam-a', x: 1, y: 2, angle: 0, materialId: 'wood', shape: { kind: 'box', width: 1, height: 2, bevel: 0.1 }, plugin: { keep: 'a' } },
        { id: 'beam-b', x: 3, y: 4, angle: 0, materialId: 'wood', shape: { kind: 'box', width: 1, height: 2, bevel: 0.2 }, plugin: { keep: 'b' } },
      ],
    },
    selectObjects(ids) { this.selectedObjectIds = [...ids]; },
    updateObjects(ids, updater) {
      const selected = new Set(ids);
      this.currentLevel.castle = this.currentLevel.castle.map((object) => selected.has(object.id) ? updater(structuredClone(object)) : object);
    },
  };
  return editor;
}

test('material resource context edits global physics fields in asset state', () => {
  const assetStore = createAssetStore(assets);
  const editorStore = editorHarness();
  const inspector = createItemInspector({ assetStore, editorStore });

  inspector.selectAsset('materials', 'wood');
  assert.deepEqual(inspector.context(), { type: 'asset', kind: 'materials', id: 'wood' });
  assert.deepEqual(inspector.fields().map(({ path }) => path), [
    'name', 'color', 'mass', 'friction', 'restitution', 'destructible', 'maxHp', 'hitSpeedThreshold',
  ]);
  inspector.patch({ mass: 3.5, friction: 0.72, maxHp: 5 });

  assert.equal(assetStore.snapshot.assets.materials.wood.mass, 3.5);
  assert.equal(assetStore.snapshot.assets.materials.wood.friction, 0.72);
  assert.equal(assetStore.snapshot.assets.materials.wood.maxHp, 5);
  assert.deepEqual(editorStore.currentLevel.castle[0].plugin, { keep: 'a' });
});

test('resource fields are kind-specific and never expose material physics on shapes', () => {
  const assetStore = createAssetStore({
    ...assets,
    specialObjects: { barrel: {
      id: 'barrel', name: '爆炸桶', specialType: 'barrel', materialId: 'wood', shapePresetId: 'square',
      color: '#d95f45', mass: 2, friction: 0.5, restitution: 0.4, destructible: true, maxHp: 1, hitSpeedThreshold: 3,
      explosion: { radius: 3, maxImpulse: 120, damage: 1, falloffExponent: 1.5, propagationSpeed: 8 },
    } },
  });
  const inspector = createItemInspector({ assetStore, editorStore: editorHarness() });

  inspector.selectAsset('shapes', 'square');
  assert.deepEqual(inspector.fields().map(({ path }) => path), ['name', 'shape']);
  assert.equal(inspector.fields().some(({ path }) => path === 'friction'), false);

  inspector.selectAsset('specialObjects', 'barrel');
  assert.deepEqual(inspector.fields().map(({ path }) => path), [
    'name', 'specialType', 'materialId', 'shapePresetId', 'color',
    'mass', 'friction', 'restitution', 'destructible', 'maxHp', 'hitSpeedThreshold', 'fixedBolt', 'explosion',
  ]);
  assert.equal(inspector.fields().find(({ path }) => path === 'fixedBolt').type, 'boolean');

  const changes = [];
  const writableInspector = createItemInspector({
    assetStore,
    editorStore: editorHarness(),
    onAssetChange: context => changes.push(context),
  });
  writableInspector.selectAsset('specialObjects', 'barrel');
  writableInspector.patch({ fixedBolt: true });
  assert.equal(assetStore.snapshot.assets.specialObjects.barrel.fixedBolt, true);
  assert.deepEqual(changes, [{ type: 'asset', kind: 'specialObjects', id: 'barrel' }]);
});

test('asset cards add on primary click or keyboard and reserve edit for the explicit action', () => {
  assert.equal(assetCardCommand({}), 'add');
  assert.equal(assetCardCommand({ key: 'Enter' }), 'add');
  assert.equal(assetCardCommand({ key: ' ' }), 'add');
  assert.equal(assetCardCommand({ key: 'Escape' }), null);
  assert.equal(assetCardCommand({ edit: true }), 'edit');
});

test('successful asset patches notify the play-session boundary but object patches do not', () => {
  const assetStore = createAssetStore(assets);
  const editorStore = editorHarness();
  const changes = [];
  const inspector = createItemInspector({ assetStore, editorStore, onAssetChange: context => changes.push(context) });

  inspector.selectAsset('materials', 'wood');
  inspector.patch({ friction: 0.61 });
  inspector.selectObjects(['beam-a']);
  inspector.patch({ friction: 0.91 });

  assert.deepEqual(changes, [{ type: 'asset', kind: 'materials', id: 'wood' }]);
});
test('canvas selection clears resource context and patches only explicit fields', () => {
  const assetStore = createAssetStore(assets);
  const editorStore = editorHarness();
  const inspector = createItemInspector({ assetStore, editorStore });
  inspector.selectAsset('materials', 'wood');
  inspector.selectObjects(['beam-a']);

  assert.equal(assetStore.snapshot.selection, null);
  assert.deepEqual(inspector.context(), { type: 'object', ids: ['beam-a'] });
  inspector.patch({ x: 9, materialId: 'stone', friction: 0.91, shape: { kind: 'circle', radius: 0.5, sensor: true } });

  assert.deepEqual(editorStore.currentLevel.castle[0], {
    id: 'beam-a', x: 9, y: 2, angle: 0, materialId: 'stone', friction: 0.91,
    shape: { kind: 'circle', radius: 0.5, sensor: true }, plugin: { keep: 'a' },
  });
  assert.equal(Object.hasOwn(editorStore.currentLevel.castle[0], 'mass'), false, 'global defaults must not be copied into object overrides');
});

test('object Item context exposes and edits the exported fixed-bolt flag', () => {
  const assetStore = createAssetStore(assets);
  const editorStore = editorHarness();
  const inspector = createItemInspector({ assetStore, editorStore });
  inspector.selectObjects(['beam-a']);

  assert.equal(inspector.fields().some(({ path }) => path === 'fixedBolt'), true);
  inspector.patch({ fixedBolt: true });
  assert.equal(editorStore.currentLevel.castle[0].fixedBolt, true);
});

test('multi-selection exposes only equal shared values and preserves every unknown field', () => {
  const editorStore = editorHarness();
  const inspector = createItemInspector({ assetStore: createAssetStore(assets), editorStore });
  inspector.selectObjects(['beam-a', 'beam-b']);

  assert.deepEqual(sharedObjectValues(editorStore.currentLevel.castle), {
    angle: 0,
    materialId: 'wood',
  });
  inspector.patch({ angle: Math.PI / 2, restitution: 0.66 });

  assert.deepEqual(editorStore.currentLevel.castle.map(({ plugin }) => plugin), [{ keep: 'a' }, { keep: 'b' }]);
  assert.deepEqual(editorStore.currentLevel.castle.map(({ shape }) => shape.bevel), [0.1, 0.2]);
  assert.deepEqual(editorStore.currentLevel.castle.map(({ restitution }) => restitution), [0.66, 0.66]);
});
