import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { decodeLevelDocument, encodeLevelDocument } from '../static/js/level-document.js';
import { drawLevel } from '../gamelogic.js';

const fixtureUrl = new URL('./fixtures/exported-level-01.json', import.meta.url);
const { assets, config } = await import('./project-config-fixture.mjs');

test('decodes exported v2 data for editing and writes the authoritative shape unchanged', async () => {
  const exported = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const level = decodeLevelDocument(exported, assets);

  assert.equal(level.levelNumber, 1);
  assert.equal(level.levelName, '直射引导');
  assert.deepEqual(level.castle[0].shape, assets.shapes.circle.shape);
  assert.deepEqual(encodeLevelDocument(level), exported);
});

test('round-trips compact frozen body groups without runtime physics fields', () => {
  const exported = {
    version: 2, type: 'level', levelId: 'level-01', level: {
      number: 1, name: '冰冻', difficulty: 'normal', description: '', normalAmmo: 1, explosiveAmmo: 0,
      splitAmmo: 3, blackHoleAmmo: 2, platformType: 'single-3',
      frozenBodies: [{ id: 'ice-1', memberIds: ['a', 'b'] }], castle: [],
    },
  };
  const level = decodeLevelDocument(exported, assets);
  assert.equal(level.splitAmmo, 3);
  assert.equal(level.blackHoleAmmo, 2);
  assert.deepEqual(level.frozenBodies, exported.level.frozenBodies);
  const encoded = encodeLevelDocument(level);
  assert.equal(encoded.level.splitAmmo, 3);
  assert.equal(encoded.level.blackHoleAmmo, 2);
  assert.deepEqual(encoded.level.frozenBodies, exported.level.frozenBodies);
  assert.equal(JSON.stringify(encodeLevelDocument(level)).includes('hitSpeedThreshold'), false);
});

test('edits v2 levels without leaking runtime-expanded fields into saved JSON', async () => {
  const exported = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const level = decodeLevelDocument(exported, assets);
  level.levelName = '直射引导（调整）';
  level.castle[0].x = 3.75;
  level.castle[0].mass = 999;

  const saved = encodeLevelDocument(level);
  assert.equal(saved.level.name, '直射引导（调整）');
  assert.equal(saved.level.castle[0].x, 3.75);
  assert.equal(Object.hasOwn(saved.level.castle[0], 'shape'), false);
  assert.equal(Object.hasOwn(saved.level.castle[0], 'mass'), false);
});

test('renders exported level 2 small-square pieces at the game importer dimensions', async () => {
  const document = await readFile(new URL('../level/关卡-002-直射破坏1.json', import.meta.url), 'utf8').then(JSON.parse);
  const level = decodeLevelDocument(document, assets);
  const calls = [];
  const context = new Proxy({ canvas: { width: config.canvas.width, height: config.canvas.height } }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });

  drawLevel(context, level, { assets, config });

  const smallSquares = calls.filter(call => call[0] === 'rect' && call[3] === 0.35 && call[4] === 0.35);
  assert.equal(smallSquares.length, 16);
});
