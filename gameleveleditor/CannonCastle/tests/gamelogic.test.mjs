import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as gameLogic from '../gamelogic.js';
import {
  calculateDifficulty,
  canvasPointToCell,
  createEmptyLevel,
  drawLevel,
  getAssetReferences,
  getBoardLayout,
  getEndActions,
  getPlayResult,
  listAssets,
  validateLevel,
} from '../gamelogic.js';
import { assetEntries } from '../static/js/asset-store.js';

const root = new URL('../', import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const [{ config, assets }, sample] = await Promise.all([
  import('./project-config-fixture.mjs'),
  readJson('tests/fixtures/legacy-level.json'),
]);

test('createEmptyLevel keeps resource and runtime defaults out of new level documents', () => {
  const level = createEmptyLevel({ id: 7, config, assets });

  assert.equal(level.levelNumber, 7);
  assert.equal(level.levelName, '新关卡 7');
  assert.equal(level.splitAmmo, 0);
  assert.equal(level.blackHoleAmmo, 0);
  assert.deepEqual(level.castle, []);
  for (const section of ['objectProfiles', 'global', 'meteor', 'explosive', 'launcher', 'environment']) {
    assert.equal(Object.hasOwn(level, section), false, `duplicated project/resource section ${section}`);
  }
  assert.equal(Object.hasOwn(level, 'width'), false);
  assert.equal(Object.hasOwn(level, 'height'), false);
  assert.equal(Object.hasOwn(level, 'board'), false);
});

test('validateLevel rejects invalid frozen body membership', () => {
  const level = { castle: [
    { id: 'a', x: 1, y: 1, angle: 0, shape: { kind: 'box', width: 1, height: 1 }, materialId: 'wood' },
    { id: 'b', x: 4, y: 1, angle: 0, shape: { kind: 'box', width: 1, height: 1 }, materialId: 'wood' },
  ], frozenBodies: [{ id: 'ice-1', memberIds: ['a', 'b'] }] };
  const result = validateLevel(level, { materials: { wood: {} } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.path === 'frozenBodies.ice-1.memberIds.b'));
});

test('drawLevel resolves colors from injected assets while explicit object overrides win', () => {
  const level = createEmptyLevel({ id: 8, config, assets });
  level.castle = [
    { id: 'inherited', x: 1, y: 1, angle: 0, materialId: 'wood', shape: { kind: 'box', width: 1, height: 1 } },
    { id: 'overridden', x: 2, y: 2, angle: 0, materialId: 'wood', color: '#123456', shape: { kind: 'box', width: 1, height: 1 } },
  ];
  const injected = structuredClone(assets);
  injected.materials.wood.color = '#abcdef';
  const fills = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) { return property in target ? target[property] : () => {}; },
    set(target, property, value) {
      target[property] = value;
      if (property === 'fillStyle') fills.push(value);
      return true;
    },
  });

  drawLevel(context, level, { assets: injected, config });

  assert.ok(fills.includes('#abcdef'));
  assert.ok(fills.includes('#123456'));
});

test('drawLevel renders magnetic alignment guides above editable objects', () => {
  const level = createEmptyLevel({ id: 81, config, assets });
  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) {
      target[property] = value;
      calls.push(['set', property, value]);
      return true;
    },
  });

  drawLevel(context, level, {
    assets,
    config,
    alignmentGuides: [
      { axis: 'x', value: 4, start: 1, end: 3 },
      { axis: 'y', value: 2, start: 1, end: 6 },
    ],
  });

  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === '#38d8ff'));
  assert.ok(calls.some(call => call[0] === 'setLineDash' && call[1][0] > 0));
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] === 4 && call[2] === 1));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 6 && call[2] === 2));
});

test('drawLevel forwards runtime HP to the original formal asset drawer without mutating the level', () => {
  const level = createEmptyLevel({ id: 80, config, assets });
  level.castle = [{
    id: 'damaged-wood', x: 4.5, y: 8, angle: 0,
    shapePresetId: 'rectangle', materialId: 'wood', hp: 1, maxHp: 2,
    shape: { kind: 'box', width: 2, height: 0.5 },
  }];
  const before = structuredClone(level);
  const received = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) { return property in target ? target[property] : () => {}; },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, {
    assets,
    config,
    formalAssetDrawer(options) { received.push(options); return true; },
  });

  assert.deepEqual(level, before);
  assert.equal(received.length, 1);
  assert.equal(received[0].shapePresetId, 'rectangle');
  assert.equal(received[0].materialId, 'wood');
  assert.equal(received[0].hp, 1);
  assert.equal(received[0].maxHp, 2);
});

test('drawLevel preserves object coordinates and geometry while ordering material, fixed bolt, then selection', () => {
  const level = createEmptyLevel({ id: 81, config, assets });
  level.castle = [{
    id: 'bolted-glass',
    x: 4.5,
    y: 10,
    angle: 0,
    shape: { kind: 'box', width: 1, height: 0.5 },
    materialId: 'glass',
    fixedBolt: true,
  }];
  const before = structuredClone(level);
  const calls = [];
  const context = new Proxy({
    canvas: { width: config.canvas.width, height: config.canvas.height },
    createRadialGradient: (...args) => {
      calls.push(['createRadialGradient', ...args]);
      return { addColorStop: (...stop) => calls.push(['addColorStop', ...stop]) };
    },
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) {
      target[property] = value;
      calls.push(['set', property, value]);
      return true;
    },
  });

  drawLevel(context, level, { assets, config, selection: ['bolted-glass'] });

  assert.deepEqual(level, before, 'drawing must not mutate coordinates, angle, geometry, or metadata');
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(151,232,245,.56)'), 'glass refraction should be visible');
  assert.ok(calls.some(call => call[0] === 'clip'), 'glass treatment should stay inside its shape');
  assert.ok(calls.some(call => call[0] === 'arc' && call[1] === -12 / 40 && call[2] === 0 && call[3] === 5 / 40), 'fixed bolt pair should include the smaller left bolt');
  assert.ok(calls.some(call => call[0] === 'arc' && call[1] === 12 / 40 && call[2] === 0 && call[3] === 5 / 40), 'fixed bolt pair should include the smaller right bolt');
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] < 0 && call[2] === 0)
    && calls.some(call => call[0] === 'lineTo' && call[1] > 0 && call[2] === 0), 'fixed bolt should have a horizontal drive groove');
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[2] < 0)
    && calls.some(call => call[0] === 'lineTo' && call[2] > 0), 'fixed bolt should have a vertical drive groove');
  const glassRefraction = calls.findIndex(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === 'rgba(151,232,245,.56)');
  const fixedBolt = calls.findIndex(call => call[0] === 'arc' && call[1] === -12 / 40 && call[2] === 0 && call[3] === 5 / 40);
  const selectionStyle = calls.findIndex(call => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === '#ffffff');
  const selectionStroke = calls.findIndex((call, index) => index > selectionStyle && call[0] === 'stroke');
  assert.ok(glassRefraction < fixedBolt, 'material surface must be drawn before fixed bolt');
  assert.ok(fixedBolt < selectionStyle && selectionStyle < selectionStroke, 'selection stroke must be drawn after fixed bolt');
});

test('drawLevel renders drag-preview objects at reduced opacity', () => {
  const level = createEmptyLevel({ id: 81, config, assets });
  level.castle = [{
    id: 'drag-preview', x: 4.5, y: 5, angle: 0,
    shape: { kind: 'box', width: 2.4, height: 0.35 }, materialId: 'wood',
  }];
  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) {
      target[property] = value;
      calls.push(['set', property, value]);
      return true;
    },
  });

  drawLevel(context, level, { assets, config, preview: ['drag-preview'] });

  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'globalAlpha' && call[2] === 0.55));
});

test('drawLevel uses shape resource data to distinguish solid and hollow boxes', () => {
  const level = createEmptyLevel({ id: 82, config, assets });
  level.castle = ['small-square', 'square'].map((shapePresetId, index) => ({
    id: `box-${index}`,
    x: index + 1,
    y: 1,
    angle: 0,
    shapePresetId,
    materialId: 'wood',
  }));
  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { assets, config });

  assert.equal(calls.filter(call => call[0] === 'clip' && call[1] === 'evenodd').length, 1);
  assert.ok(calls.some(call => call[0] === 'rect'
    && Math.abs(call[1] + 0.14) < 1e-12
    && Math.abs(call[2] + 0.14) < 1e-12
    && Math.abs(call[3] - 0.28) < 1e-12
    && Math.abs(call[4] - 0.28) < 1e-12));
});

test('drawLevel does not hollow-clip special squares like the explosive barrel', () => {
  const level = createEmptyLevel({ id: 82, config, assets });
  level.castle = [
    { id: 'barrel', x: 2, y: 1, angle: 0, shapePresetId: 'square', shape: { kind: 'box', width: 1, height: 1 }, materialId: 'wood', specialType: 'explosive-barrel' },
    { id: 'plain', x: 4, y: 1, angle: 0, shapePresetId: 'square', shape: { kind: 'box', width: 1, height: 1 }, materialId: 'wood' },
  ];
  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { assets, config });

  assert.equal(calls.filter(call => call[0] === 'clip' && call[1] === 'evenodd').length, 1,
    'only the plain square stays hollow; the explosive barrel must render solid');
});

test('drawLevel renders the original placement platform and supporting hill in world coordinates', () => {
  const level = createEmptyLevel({ id: 9, config, assets });
  const platformConfig = structuredClone(config);
  platformConfig.runtime.environment = {
    ...platformConfig.runtime.environment,
    baseWidth: 3,
  };
  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { assets, config: platformConfig });

  assert.ok(calls.some(call => call[0] === 'fillRect' && call[1] === 3 && call[2] === 12.34 && call[3] === 3 && call[4] === 0.32));
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] === 0 && call[2] === 16));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 4.5 && call[2] === 12.85));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 9 && call[2] === 16));
});

test('drawLevel preserves the original split-platform geometry', () => {
  const level = createEmptyLevel({ id: 10, config, assets });
  const platformConfig = structuredClone(config);
  platformConfig.runtime.environment = {
    ...platformConfig.runtime.environment,
    baseWidth: 4,
    platformType: 'double-2',
  };
  level.platformType = 'double-2';
  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { assets, config: platformConfig });

  const platforms = calls.filter(call => call[0] === 'fillRect' && call[2] === 12.34 && call[4] === 0.32);
  assert.deepEqual(platforms, [
    ['fillRect', 2.1, 12.34, 2, 0.32],
    ['fillRect', 4.9, 12.34, 2, 0.32],
  ]);
});

test('drawLevel shows both original projectile rebound walls down to the platform base', () => {
  const level = createEmptyLevel({ id: 11, config, assets });
  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { assets, config });

  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] === 0 && call[2] === 0));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 0 && call[2] === 12.66));
  assert.ok(calls.some(call => call[0] === 'moveTo' && call[1] === 9 && call[2] === 0));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 9 && call[2] === 12.66));
});

test('drawLevel fills the hill through letterbox space to the visible canvas bottom', () => {
  const level = createEmptyLevel({ id: 12, config, assets });
  const tallConfig = structuredClone(config);
  tallConfig.canvas = { width: 9, height: 20 };
  const calls = [];
  const context = new Proxy({ canvas: { width: 9, height: 20 } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { assets, config: tallConfig });

  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 9 && call[2] === 18));
  assert.ok(calls.some(call => call[0] === 'lineTo' && call[1] === 0 && call[2] === 18));
  assert.ok(calls.some(call => call[0] === 'fill'));
});

test('validation accepts the playable sample and never normalizes away unknown fields', () => {
  const level = structuredClone(sample);
  level.authoring = { note: 'keep me' };
  level.castle[0].pluginData = { lockedBy: 'designer' };
  const before = structuredClone(level);

  assert.deepEqual(validateLevel(level, assets), { ok: true, errors: [] });
  assert.deepEqual(level, before);
});

test('validation rejects malformed box, circle, and polygon geometry at the object path', () => {
  const level = structuredClone(sample);
  level.castle = [
    { ...level.castle[0], id: 'box', shape: { kind: 'box', width: 0, height: 1 } },
    { ...level.castle[0], id: 'circle', shape: { kind: 'circle', radius: -1 } },
    { ...level.castle[0], id: 'polygon', shape: { kind: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } },
  ];

  const result = validateLevel(level, assets);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(({ path }) => path), [
    'castle.box.shape',
    'castle.circle.shape',
    'castle.polygon.shape',
  ]);
});

test('validation enforces the original fixed-bolt material contract', () => {
  const invalidFalse = structuredClone(sample.castle[0]);
  invalidFalse.id = 'false-bolt';
  invalidFalse.fixedBolt = false;
  const invalidStone = structuredClone(sample.castle[0]);
  invalidStone.id = 'stone-bolt';
  invalidStone.materialId = 'stone';
  invalidStone.fixedBolt = true;
  const level = { ...structuredClone(sample), castle: [invalidFalse, invalidStone] };

  const result = validateLevel(level, assets);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(({ path }) => path), [
    'castle.false-bolt.fixedBolt',
    'castle.stone-bolt.fixedBolt',
  ]);
});

test('legacy runtime validation accepts explicit false bolt overrides without weakening authored validation', () => {
  assert.equal(typeof gameLogic.validateLegacyRuntimeLevel, 'function');
  const level = structuredClone(sample);
  level.castle[0].fixedBolt = false;
  const before = structuredClone(level);

  assert.equal(validateLevel(level, assets).ok, false, 'authored v2 must remain strict');
  assert.deepEqual(gameLogic.validateLegacyRuntimeLevel(level, assets), { ok: true, errors: [] });
  assert.deepEqual(level, before, 'legacy validation must be lossless');

  level.castle[0].fixedBolt = 'false';
  assert.equal(gameLogic.validateLegacyRuntimeLevel(level, assets).ok, false, 'legacy boundary accepts only booleans or omission');
});

test('validation rejects every explicit object physics override outside its runtime range', () => {
  const fields = [
    ['mass', 0],
    ['friction', 1.01],
    ['restitution', -0.01],
    ['maxHp', 0],
    ['hitSpeedThreshold', -0.01],
  ];
  for (const [field, value] of fields) {
    const level = structuredClone(sample);
    level.castle = [{ ...level.castle[0], [field]: value }];
    const result = validateLevel(level, assets);
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some(error => error.path === `castle.${level.castle[0].id}.${field}`), field);
  }
});

test('board layout and point conversion use config canvas and world dimensions', () => {
  const layout = getBoardLayout(sample, { width: 10, height: 10 }, config);

  assert.equal(layout.canvasWidth, config.canvas.width);
  assert.equal(layout.canvasHeight, config.canvas.height);
  assert.equal(layout.worldWidth, config.world.width);
  assert.equal(layout.worldHeight, config.world.height);
  assert.equal(layout.scale, Math.min(config.canvas.width / config.world.width, config.canvas.height / config.world.height));
  assert.deepEqual(canvasPointToCell(layout.left, layout.top, layout, sample), { x: 0, y: 0 });
  assert.deepEqual(
    canvasPointToCell(layout.left + layout.width, layout.top + layout.height, layout, sample),
    { x: config.world.width, y: config.world.height },
  );
  assert.equal(canvasPointToCell(layout.left - 1, layout.top, layout, sample), null);
});

test('board layout rejects missing or invalid config dimensions instead of using canvas or game-specific fallbacks', () => {
  assert.throws(
    () => getBoardLayout(sample, { width: 750, height: 1624 }, {}),
    /config\.canvas\.width.*config\.canvas\.height/,
  );
  assert.throws(
    () => getBoardLayout(sample, { width: 750, height: 1624 }, { canvas: { width: 0, height: 1624 }, world: config.world }),
    /config\.canvas\.width.*config\.canvas\.height/,
  );
});

test('game adapter ignores removed combination-template catalogs and references', () => {
  const withLegacyTemplate = {
    ...assets,
    templates: { forbidden: { name: '组合模板', symbol: '◆' } },
  };
  const level = structuredClone(sample);
  level.castle[0].templateId = 'forbidden';

  assert.equal(listAssets(withLegacyTemplate).some(({ id }) => id === 'forbidden'), false);
  assert.equal(getAssetReferences(level, 'forbidden'), false);
});

test('game asset listing reuses the production projection and data-driven hollow symbols', () => {
  const listed = listAssets(assets);
  assert.deepEqual(listed, assetEntries(assets));
  const hollowShapeIds = listed.filter(entry => entry.kind === 'shapes' && entry.symbol === '□').map(entry => entry.id);
  assert.deepEqual(hollowShapeIds, ['square']);
});

test('game asset listing does not let legacy categories bypass the production projection', () => {
  const withConflictingCategories = {
    ...assets,
    categories: [{ items: [{ id: 'square', kind: 'shapes', symbol: '■' }] }],
  };

  assert.deepEqual(listAssets(withConflictingCategories), assetEntries(withConflictingCategories));
});

test('asset references, difficulty, end actions, and drawing operate on castle objects', () => {
  assert.equal(getAssetReferences(sample, sample.castle[0].materialId), true);
  assert.equal(getAssetReferences(sample, sample.castle[0].shapePresetId), true);
  assert.equal(getAssetReferences(sample, 'not-used'), false);

  const difficulty = calculateDifficulty(sample, assets);
  assert.ok(difficulty.score > 0);
  assert.ok(['简单', '普通', '困难', '专家'].includes(difficulty.level));
  assert.deepEqual(getEndActions('won', true), { retry: true, next: true });
  assert.equal(getPlayResult(sample), 'won');

  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });
  const drawable = structuredClone(sample);
  drawable.castle.push({
    id: 'draw-circle',
    name: '绘制圆形',
    x: 4.5,
    y: 9,
    angle: 0,
    shape: { kind: 'circle', radius: 0.3 },
    materialId: 'wood',
  });
  drawLevel(context, drawable, { assets, config });
  assert.ok(calls.some(([name]) => name === 'fillRect'), 'box objects should be drawn');
  assert.ok(calls.some(([name]) => name === 'arc'), 'circle objects should be drawn');
  assert.ok(calls.some(([name]) => name === 'lineTo'), 'polygon objects should be drawn');
});

test('drawLevel passes original level angles to Canvas as radians', () => {
  const level = structuredClone(sample);
  level.castle = [{ ...level.castle[0], angle: 1.57079632679 }];
  const calls = [];
  const context = new Proxy({ canvas: { width: 750, height: 1624 } }, {
    get(target, property) { return property in target ? target[property] : (...args) => calls.push([property, ...args]); },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { config });

  assert.ok(calls.some(([name, angle]) => name === 'rotate' && angle === 1.57079632679));
});

test('fixed objects draw the original pair of bolts instead of one centered bolt', () => {
  const level = createEmptyLevel({ id: 83, config, assets });
  level.castle = [{
    id: 'bolted', x: 4.5, y: 8, angle: 0, fixedBolt: true,
    shapePresetId: 'rectangle', materialId: 'wood',
    shape: { kind: 'box', width: 2, height: 0.5 },
  }];
  const calls = [];
  const context = new Proxy({
    canvas: { width: config.canvas.width, height: config.canvas.height },
    createRadialGradient: () => ({ addColorStop() {} }),
  }, {
    get(target, property) { return property in target ? target[property] : (...args) => calls.push([property, ...args]); },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { assets, config, formalAssetDrawer: () => true });

  assert.ok(calls.some(call => call[0] === 'arc' && call[1] === -12 / 40 && call[2] === 0 && call[3] === 5 / 40));
  assert.ok(calls.some(call => call[0] === 'arc' && call[1] === 12 / 40 && call[2] === 0 && call[3] === 5 / 40));
  assert.equal(calls.some(call => call[0] === 'arc' && call[1] === 0 && call[2] === 0 && call[3] >= 0.13), false);
});

test('original play helpers draw cannon, projectile styles, and canvas HUD without item health bars', () => {
  for (const name of ['drawPlayCannon', 'drawPlayProjectile', 'drawPlayHud']) {
    assert.equal(typeof gameLogic[name], 'function', `${name} must be exported for the play renderer`);
  }
  assert.equal(gameLogic.drawDurability, undefined);
  const calls = [];
  const context = new Proxy({ canvas: { width: 360, height: 640 } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) {
      target[property] = value;
      calls.push(['set', property, value]);
      return true;
    },
  });

  gameLogic.drawPlayCannon(context, 30);
  gameLogic.drawPlayProjectile(context, { x: 2, y: 3, radius: 0.2, meteorType: 'normal' });
  gameLogic.drawPlayProjectile(context, { x: 3, y: 4, radius: 0.2, meteorType: 'explosive' });
  gameLogic.drawPlayHud(context, { normalAmmo: 7, phase: 'playing', remainingTargets: 3 }, { canvasWidth: 360 });

  assert.ok(calls.some(call => call[0] === 'rotate' && call[1] === -30 * Math.PI / 180));
  assert.equal(calls.some(call => call[0] === 'fillText' && String(call[1]).startsWith('HP ')), false);
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'fillStyle' && call[2] === '#ff654f'));
  assert.ok(calls.some(call => call[0] === 'set' && call[1] === 'fillStyle' && call[2] === '#d93855'));
  assert.ok(calls.some(call => call[0] === 'fillText' && call[1] === '普通炮弹 7'));
  assert.ok(calls.some(call => call[0] === 'fillText' && call[1] === 'PLAYING'));
  assert.ok(calls.some(call => call[0] === 'fillText' && call[1] === 'TARGET 3'));
});
