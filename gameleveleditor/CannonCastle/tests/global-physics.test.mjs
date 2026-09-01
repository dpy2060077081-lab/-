import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { EditorStore } from '../static/js/editor-store.js';
import * as editorModule from '../static/js/editor.js';
import * as physicsModule from '../static/js/global-physics-store.js';

const { createGlobalPhysicsStore } = physicsModule;

const { config: defaults, assets } = await import('./project-config-fixture.mjs');

test('resource physics lives in asset data and changes publish one global revision', () => {
  const store = createGlobalPhysicsStore({ defaults, assets });
  const revisions = [];
  store.subscribe((snapshot) => revisions.push(snapshot.revision));

  const result = store.applyPatch('assets.materials.wood.friction', 0.77);

  assert.equal(result.ok, true);
  assert.equal(store.getSnapshot().assets.materials.wood.friction, 0.77);
  assert.deepEqual(revisions, [1]);
  assert.equal(store.runtimeConfig().objectProfiles.materials.wood.friction, 0.77);
});

test('global object profile sections expose every material physics setting in the global panel', () => {
  const sections = editorModule.globalObjectProfileSections?.(assets);

  assert.deepEqual(sections?.map(section => section.id), ['wood', 'glass', 'stone', 'metal', 'rubber']);
  assert.deepEqual(sections?.[0], {
    id: 'wood',
    title: '木头',
    fields: [
      { key: 'mass', label: '质量', type: 'number', step: '0.01' },
      { key: 'friction', label: '摩擦系数', type: 'number', step: '0.01' },
      { key: 'restitution', label: '弹性系数', type: 'number', step: '0.01' },
      { key: 'maxHp', label: '耐久', type: 'number', step: '1' },
      { key: 'hitSpeedThreshold', label: '碰撞速度阈值', type: 'number', step: '0.1' },
      { key: 'destructible', label: '可破坏', type: 'boolean' },
    ],
  });
});

test('editing a global material profile updates the asset used by global JSON saving', () => {
  const store = new EditorStore({ config: defaults, assets, levels: [] });

  const result = editorModule.applyGlobalObjectProfileChange?.({
    editorStore: store,
    materialId: 'glass',
    field: 'restitution',
    value: 0.33,
  });

  assert.equal(result?.ok, true);
  assert.equal(store.assets.materials.glass.restitution, 0.33);
  assert.equal(store.assetsDirty, true);
  assert.equal(store.dirty, true);
});

test('invalid resource physics is rejected without replacing the last valid config', () => {
  const store = createGlobalPhysicsStore({ defaults, assets });
  const before = store.getSnapshot();
  const result = store.applyPatch('assets.materials.glass.friction', -1);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_GLOBAL_PHYSICS');
  assert.deepEqual(store.getSnapshot(), before);
});

test('project config owns every editable runtime physics group without copying it into a new level', async () => {
  const store = createGlobalPhysicsStore({ defaults, assets });
  const fields = physicsModule.RUNTIME_PHYSICS_FIELDS;

  assert.deepEqual(new Set(fields?.map(field => field.group)), new Set([
    'environment', 'launcher', 'normalProjectile', 'explosiveProjectile', 'explosionPropagation', 'splitProjectile', 'blackHoleProjectile', 'frozenBody',
  ]));
  assert.equal(defaults.runtime.global.gravity, 9.8);
  assert.equal(defaults.runtime.meteor.radius, 0.32);
  assert.equal(defaults.runtime.explosive.propagationSpeed > 0, true);
  assert.equal(store.runtimeConfig().global.gravity, 9.8);
});

test('edits frozenBody through runtime physics fields and publishes it as an object profile', () => {
  const store = createGlobalPhysicsStore({ defaults, assets });
  const frozenFields = physicsModule.RUNTIME_PHYSICS_FIELDS.filter(field => field.group === 'frozenBody');

  assert.deepEqual(frozenFields.map(field => field.path), [
    'runtime.frozenBody.friction',
    'runtime.frozenBody.restitution',
    'runtime.frozenBody.hitSpeedThreshold',
  ]);
  assert.deepEqual(store.runtimeConfig().objectProfiles.frozenBody, {
    friction: 0.1,
    restitution: 0.2,
    hitSpeedThreshold: 5,
  });

  const result = store.applyPatch('config.runtime.frozenBody.hitSpeedThreshold', 8);

  assert.equal(result.ok, true);
  assert.equal(store.getSnapshot().config.runtime.frozenBody.hitSpeedThreshold, 8);
  assert.equal(store.runtimeConfig().objectProfiles.frozenBody.hitSpeedThreshold, 8);
});

test('reports every out-of-range frozenBody field through project config validation', () => {
  for (const [path, value] of [
    ['runtime.frozenBody.friction', -0.01],
    ['runtime.frozenBody.friction', 1.01],
    ['runtime.frozenBody.restitution', -0.01],
    ['runtime.frozenBody.restitution', 1.01],
    ['runtime.frozenBody.hitSpeedThreshold', -0.01],
  ]) {
    const invalid = structuredClone(defaults);
    invalid.runtime.frozenBody = { friction: 0.1, restitution: 0.2, hitSpeedThreshold: 5 };
    const parts = path.split('.');
    parts.slice(0, -1).reduce((valueAtPath, part) => valueAtPath[part], invalid)[parts.at(-1)] = value;

    const result = physicsModule.validateProjectConfig(invalid);

    assert.equal(result.ok, false, `${path}=${value} should be rejected`);
    assert.equal(result.errors.some(error => error.path === path), true);
  }
});

test('ammo remains a valid compatibility default without appearing in global editable fields', () => {
  const paths = physicsModule.RUNTIME_PHYSICS_FIELDS.map(field => field.path);

  assert.equal(paths.includes('runtime.global.initialAmmo'), false);
  assert.equal(paths.includes('runtime.global.explosiveAmmo'), false);
  assert.equal(defaults.runtime.global.initialAmmo, 15);
  assert.equal(defaults.runtime.global.explosiveAmmo, 1);
  assert.equal(physicsModule.validateProjectConfig(defaults).ok, true);
});

test('validated runtime config edits dirty unified config and rebuild play exactly once', async () => {
  const level = JSON.parse(await readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  const store = new EditorStore({ config: defaults, assets, levels: [level] });
  let rebuilds = 0;

  const valid = editorModule.applyGlobalConfigChange?.({
    editorStore: store,
    path: 'runtime.global.gravity',
    value: 8.4,
    playing: true,
    rebuild: () => { rebuilds += 1; },
  });

  assert.equal(valid?.ok, true);
  assert.equal(store.config.runtime.global.gravity, 8.4);
  assert.equal(store.configDirty, true);
  assert.equal(rebuilds, 1);

  const revision = store.revision;
  const invalid = editorModule.applyGlobalConfigChange?.({
    editorStore: store,
    path: 'runtime.meteor.friction',
    value: 1.5,
    playing: true,
    rebuild: () => { rebuilds += 1; },
  });
  assert.equal(invalid?.ok, false);
  assert.equal(invalid?.error.path, 'runtime.meteor.friction');
  assert.equal(store.revision, revision);
  assert.equal(store.config.runtime.meteor.friction, defaults.runtime.meteor.friction);
  assert.equal(rebuilds, 1);
});
