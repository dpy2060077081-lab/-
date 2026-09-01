import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assetEntries,
  createAssetObject,
  createAssetStore,
  isHexColor,
  scanAssetReferences,
  validateAssetGraph,
} from '../static/js/asset-store.js';
import { EditorStore } from '../static/js/editor-store.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';

const globalDocument = JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8'));
const { assets } = decodeGlobalConfig(globalDocument);

test('hex color validation is shared by asset validation and visual sanitization', () => {
  for (const color of ['#963', '#1234', '#102030', '#102030ff']) assert.equal(isHexColor(color), true);
  for (const color of ['red', '#12', '#xyzxyz', ' #102030 ']) assert.equal(isHexColor(color), false);
});

test('material edits update asset state without mutating the source', () => {
  const source = structuredClone(assets);
  const store = createAssetStore(source);

  store.select('materials', 'wood');
  store.patchSelected({ friction: 0.73, maxHp: 4 });

  assert.equal(store.snapshot.assets.materials.wood.friction, 0.73);
  assert.equal(store.snapshot.assets.materials.wood.maxHp, 4);
  assert.deepEqual(store.snapshot.selection, { kind: 'materials', id: 'wood' });
  assert.equal(store.snapshot.dirty, true);
  assert.deepEqual(source, assets);
  assert.deepEqual(Object.keys(store.snapshot.assets).sort(), ['materials', 'shapes', 'specialObjects']);
});

test('invalid material edits keep the last valid asset snapshot', () => {
  const store = createAssetStore(assets);
  store.select('materials', 'wood');

  assert.throws(
    () => store.patchSelected({ friction: -1 }),
    (error) => error.code === 'ASSET_INVALID' && error.details.field === 'friction',
  );
  assert.equal(store.snapshot.assets.materials.wood.friction, assets.materials.wood.friction);
  assert.equal(store.snapshot.dirty, false);
  assert.equal(store.snapshot.validation.ok, false);
});

test('referenced resource deletion reports every matching level and object', () => {
  const levels = Array.from({ length: 54 }, (_, index) => ({
    filePath: `level/original-${String(index + 1).padStart(2, '0')}-level-${String(index + 1).padStart(2, '0')}.json`,
    castle: [{
      id: `beam-${index + 1}`,
      name: `Beam ${index + 1}`,
      x: 1,
      y: 1,
      angle: 0,
      shape: { kind: 'box', width: 1, height: 0.2 },
      materialId: 'wood',
    }],
  }));
  const references = scanAssetReferences(levels, 'wood');
  assert.equal(references.length, 54);
  assert.deepEqual(references.at(0), {
    levelPath: 'level/original-01-level-01.json',
    levelId: undefined,
    objectId: 'beam-1',
    field: 'materialId',
  });
  assert.deepEqual(references.at(-1), {
    levelPath: 'level/original-54-level-54.json',
    levelId: undefined,
    objectId: 'beam-54',
    field: 'materialId',
  });

  const store = createAssetStore(assets);
  assert.throws(
    () => store.remove('materials', 'wood', references),
    (error) => error.code === 'ASSET_REFERENCED'
      && error.details.references.length === 54
      && error.message.includes('original-54-level-54.json'),
  );
});

test('asset entries expose exactly materials, shapes, and special objects', () => {
  const entries = assetEntries({ ...assets, templates: { forbidden: { id: 'forbidden' } } });
  assert.deepEqual([...new Set(entries.map(({ kind }) => kind))], ['materials', 'shapes', 'specialObjects']);
  assert.equal(entries.some(({ id }) => id === 'forbidden'), false);
});

test('shape resource symbols distinguish data-driven hollow squares', () => {
  const symbols = Object.fromEntries(assetEntries(assets)
    .filter(entry => entry.kind === 'shapes')
    .map(entry => [entry.id, entry.symbol]));

  assert.deepEqual(symbols, {
    square: '□',
    rectangle: '■',
    'long-thin-rectangle': '■',
    'short-thin-rectangle': '■',
    'small-square': '■',
    circle: '●',
    'isosceles-triangle': '▲',
    'right-triangle': '▲',
  });
  assert.deepEqual(Object.entries(symbols).filter(([, symbol]) => symbol === '□').map(([id]) => id), ['square']);
});

test('material, shape, and special resources create unique original-compatible objects', () => {
  const customized = structuredClone(assets);
  customized.specialObjects['explosive-barrel'].fixedBolt = true;
  const level = { castle: [{ id: 'wood-1' }, { id: 'square-1' }, { id: 'explosive-barrel-1' }] };

  const material = createAssetObject({ assets, kind: 'materials', id: 'wood', level, point: { x: 2, y: 3 } });
  const shape = createAssetObject({ assets, kind: 'shapes', id: 'circle', level, point: { x: 4, y: 5 } });
  const special = createAssetObject({ assets: customized, kind: 'specialObjects', id: 'explosive-barrel', level, point: { x: 6, y: 7 } });

  assert.equal(material.id, 'wood-2');
  assert.equal(material.materialId, 'wood');
  assert.equal(material.shapePresetId, 'square');
  assert.deepEqual(material.shape, assets.shapes.square.shape);
  assert.deepEqual(Object.keys(material).sort(), ['angle', 'id', 'materialId', 'name', 'shape', 'shapePresetId', 'x', 'y']);
  assert.deepEqual({ x: material.x, y: material.y, angle: material.angle }, { x: 2, y: 3, angle: 0 });

  assert.equal(shape.id, 'circle-1');
  assert.equal(shape.materialId, 'wood');
  assert.equal(shape.shapePresetId, 'circle');
  assert.deepEqual(shape.shape, assets.shapes.circle.shape);
  assert.equal(Object.hasOwn(shape, 'friction'), false);

  assert.equal(special.id, 'explosive-barrel-2');
  assert.equal(special.specialType, 'explosive-barrel');
  assert.equal(Object.hasOwn(special, 'explosion'), false);
  assert.equal(Object.hasOwn(special, 'friction'), false);
  assert.equal(Object.hasOwn(special, 'fixedBolt'), false);
});

test('asset graph rejects typed-number, geometry, convexity, and dependency violations', () => {
  const invalidCases = [
    ['numeric strings', draft => { draft.materials.wood.mass = '2'; }, 'mass'],
    ['material friction above one', draft => { draft.materials.wood.friction = 1.01; }, 'friction'],
    ['material restitution above one', draft => { draft.materials.wood.restitution = 1.01; }, 'restitution'],
    ['special friction above one', draft => { draft.specialObjects['explosive-barrel'].friction = 1.01; }, 'friction'],
    ['special restitution above one', draft => { draft.specialObjects['explosive-barrel'].restitution = 1.01; }, 'restitution'],
    ['zero box width', draft => { draft.shapes.square.shape.width = 0; }, 'shape.width'],
    ['string circle radius', draft => { draft.shapes.circle.shape.radius = '0.2'; }, 'shape.radius'],
    ['concave polygon', draft => { draft.shapes['right-triangle'].shape.vertices = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 2 }, { x: 0, y: 2 }]; }, 'shape.vertices'],
    ['duplicate polygon vertex', draft => { draft.shapes['right-triangle'].shape.vertices = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]; }, 'shape.vertices'],
    ['missing material dependency', draft => { draft.specialObjects['explosive-barrel'].materialId = 'missing'; }, 'materialId'],
    ['missing shape dependency', draft => { draft.specialObjects['explosive-barrel'].shapePresetId = 'missing'; }, 'shapePresetId'],
    ['unknown top-level catalog', draft => { draft.otherAssets = {}; }, 'otherAssets'],
  ];

  for (const [name, mutate, field] of invalidCases) {
    const draft = structuredClone(assets);
    mutate(draft);
    assert.throws(
      () => validateAssetGraph(draft),
      (error) => error.code === 'ASSET_INVALID' && error.details.field === field,
      name,
    );
  }
  assert.doesNotThrow(() => validateAssetGraph(assets));
});

test('asset graph validates colors, safe staged-image paths, and complete explosion definitions', () => {
  const invalidCases = [
    ['missing material color', draft => { delete draft.materials.wood.color; }, 'color'],
    ['non-string material color', draft => { draft.materials.wood.color = 123; }, 'color'],
    ['unsupported material color', draft => { draft.materials.wood.color = 'wood'; }, 'color'],
    ['missing special color', draft => { delete draft.specialObjects['explosive-barrel'].color; }, 'color'],
    ['unsupported special color', draft => { draft.specialObjects['explosive-barrel'].color = 'rgb(1,2,3)'; }, 'color'],
    ['absolute image path', draft => { draft.materials.wood.image = '/level/asset/wood.png'; }, 'image'],
    ['escaping image path', draft => { draft.materials.wood.image = 'level/asset/../wood.png'; }, 'image'],
    ['backslash image path', draft => { draft.materials.wood.image = 'level\\asset\\wood.png'; }, 'image'],
    ['empty explosion', draft => { draft.specialObjects['explosive-barrel'].explosion = {}; }, 'explosion.radius'],
    ['missing explosion field', draft => { delete draft.specialObjects['explosive-barrel'].explosion.maxImpulse; }, 'explosion.maxImpulse'],
    ['zero explosion radius', draft => { draft.specialObjects['explosive-barrel'].explosion.radius = 0; }, 'explosion.radius'],
    ['negative explosion damage', draft => { draft.specialObjects['explosive-barrel'].explosion.damage = -1; }, 'explosion.damage'],
    ['extra nonnumeric explosion field', draft => { draft.specialObjects['explosive-barrel'].explosion.extension = 'bad'; }, 'explosion.extension'],
  ];

  for (const [name, mutate, field] of invalidCases) {
    const draft = structuredClone(assets);
    mutate(draft);
    assert.throws(
      () => validateAssetGraph(draft),
      (error) => error.code === 'ASSET_INVALID' && error.details.field === field,
      name,
    );
  }

  const valid = structuredClone(assets);
  valid.materials.wood.color = '#abcd';
  valid.materials.wood.image = 'level/asset/wood-grain.v2.png';
  valid.specialObjects['explosive-barrel'].explosion.damage = 0;
  assert.doesNotThrow(() => validateAssetGraph(valid));
});

test('save rejects an invalid unused asset graph before writing any file', async () => {
  const invalid = structuredClone(assets);
  invalid.shapes.circle.shape.radius = -1;
  const level = JSON.parse(await readFile(new URL('./fixtures/legacy-level.json', import.meta.url), 'utf8'));
  const writes = [];
  const files = {
    async mkdir() {}, async writeBase64() {}, async remove() {},
    async writeText(path) { writes.push(path); },
  };
  const store = new EditorStore({ config: {}, assets: invalid, levels: [{ ...level, filePath: 'level/level-1.json' }], files });

  await assert.rejects(
    () => store.save(),
    (error) => error.code === 'ASSET_INVALID' && error.details.field === 'shape.radius',
  );
  assert.deepEqual(writes, []);
});

test('saving a newly created object does not persist inherited material physics as overrides', async () => {
  const level = JSON.parse(await readFile(new URL('./fixtures/legacy-level.json', import.meta.url), 'utf8'));
  const writes = new Map();
  const files = {
    async mkdir() {}, async writeBase64() {}, async remove() {},
    async writeText(path, value) { writes.set(path, value); },
  };
  const store = new EditorStore({
    config: {},
    assets,
    levels: [{ ...level, levelNumber: 1, levelName: 'Fixture', filePath: 'level/level-1.json' }],
    files,
  });
  const created = store.addObjectFromAsset('shapes', 'circle', { x: 4, y: 8 });
  await store.save();

  const saved = JSON.parse(writes.get('level/level-1.json')).castle.find(object => object.id === created.id);
  for (const field of ['mass', 'friction', 'restitution', 'destructible', 'maxHp', 'hitSpeedThreshold', 'color']) {
    assert.equal(Object.hasOwn(saved, field), false, `${field} must remain inherited`);
  }
});

test('resource creation uses available defaults instead of requiring wood and square', () => {
  const alternate = {
    materials: { clay: { id: 'clay', name: '黏土', color: '#963', mass: 2, friction: 0.4, restitution: 0.2, destructible: true, maxHp: 2, hitSpeedThreshold: 2 } },
    shapes: { disc: { id: 'disc', name: '圆片', shape: { kind: 'circle', radius: 0.4 } } },
    specialObjects: {},
  };

  assert.equal(createAssetObject({ assets: alternate, kind: 'materials', id: 'clay', level: { castle: [] } }).shapePresetId, 'disc');
  assert.equal(createAssetObject({ assets: alternate, kind: 'shapes', id: 'disc', level: { castle: [] } }).materialId, 'clay');
});

test('editor store wires asset selection, object creation, and full-catalog reference protection', () => {
  const levels = Array.from({ length: 54 }, (_, index) => ({
    levelNumber: index + 1,
    fileName: `original-${String(index + 1).padStart(2, '0')}.json`,
    filePath: `level/original-${String(index + 1).padStart(2, '0')}.json`,
    castle: [{
      id: `beam-${index + 1}`,
      name: `Beam ${index + 1}`,
      x: 1,
      y: 1,
      angle: 0,
      shape: { kind: 'box', width: 1, height: 0.2 },
      materialId: 'wood',
    }],
  }));
  const store = new EditorStore({ config: { world: { width: 9, height: 16 } }, assets, levels });

  store.selectAsset('circle', 'shapes');
  assert.deepEqual(store.itemContext, { type: 'asset', kind: 'shapes', id: 'circle' });
  const created = store.addObjectFromAsset('shapes', 'circle', { x: 4.5, y: 8 });
  assert.equal(created.shape.kind, 'circle');
  assert.deepEqual(store.itemContext, { type: 'object', ids: [created.id] });
  assert.equal(store.currentLevel.castle.at(-1).id, created.id);

  assert.throws(
    () => store.deleteAsset('wood'),
    (error) => error.code === 'ASSET_REFERENCED'
      && error.details.references.length === 56
      && error.message.includes('original-54.json'),
  );
});

test('editor store material patches preserve unknown resource fields and staged image intent', () => {
  const customized = structuredClone(assets);
  customized.materials.wood.image = 'level/asset/wood.png';
  customized.materials.wood.extension = { shader: 'grain' };
  const store = new EditorStore({ config: {}, assets: customized, levels: [{ levelNumber: 1, castle: [] }] });

  store.updateAsset('wood', { id: 'wood', friction: 0.81 });

  assert.equal(store.assets.materials.wood.image, 'level/asset/wood.png');
  assert.deepEqual(store.assets.materials.wood.extension, { shader: 'grain' });
  assert.deepEqual([...store.deletedImagePaths], []);
});

test('editor store rejects invalid global material values without dirtying assets', () => {
  const store = new EditorStore({ config: {}, assets, levels: [{ levelNumber: 1, castle: [] }] });

  assert.throws(
    () => store.updateAsset('wood', { id: 'wood', mass: 0 }),
    (error) => error.code === 'ASSET_INVALID' && error.details.field === 'mass',
  );
  assert.equal(store.assets.materials.wood.mass, assets.materials.wood.mass);
  assert.equal(store.dirty, false);
  assert.equal(store.history.length, 0);
});

test('deleting a newly staged image removes it from save queues instead of scheduling disk work', () => {
  const store = new EditorStore({ config: {}, assets, levels: [{ levelNumber: 1, castle: [] }] });
  const image = 'level/asset/banner.png';

  store.addAsset('specialObjects', { id: 'banner', name: '旗帜', specialType: 'banner', materialId: 'wood', shapePresetId: 'square', color: '#336699', image }, 'base64-data');
  assert.equal(store.pendingImages.has(image), true);
  store.deleteAsset('banner');

  assert.equal(store.pendingImages.has(image), false);
  assert.equal(store.deletedImagePaths.has(image), false);
});

test('reusing a deleted image path cancels deletion so save cannot write and then remove it', () => {
  const customized = structuredClone(assets);
  customized.specialObjects.banner = { id: 'banner', name: '旧旗帜', specialType: 'banner', materialId: 'wood', shapePresetId: 'square', color: '#336699', image: 'level/asset/banner.png' };
  const store = new EditorStore({ config: {}, assets: customized, levels: [{ levelNumber: 1, castle: [] }] });

  store.deleteAsset('banner');
  store.addAsset('specialObjects', { id: 'banner', name: '新旗帜', specialType: 'banner', materialId: 'wood', shapePresetId: 'square', color: '#336699', image: 'level/asset/banner.png' }, 'new-base64');

  assert.equal(store.pendingImages.has('level/asset/banner.png'), true);
  assert.equal(store.deletedImagePaths.has('level/asset/banner.png'), false);
});

test('resource deletion protects references held by special-object definitions', () => {
  const store = new EditorStore({ config: {}, assets, levels: [{ levelNumber: 1, castle: [] }] });

  assert.throws(
    () => store.deleteAsset('square'),
    (error) => error.code === 'ASSET_REFERENCED'
      && error.details.references.some(reference => reference.levelPath === '全局配置.json' && reference.objectId === 'explosive-barrel'),
  );
});
