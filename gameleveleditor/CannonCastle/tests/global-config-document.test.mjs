import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  assertGlobalConfigDocument,
  decodeGlobalConfig,
  encodeGlobalConfig,
} from '../static/js/global-config-document.js';
import { saveWorkspace } from '../static/js/editor-store.js';

const fixture = () => ({
  version: 2,
  type: 'global',
  projectName: '陨石城堡',
  canvas: { width: 750, height: 1624 },
  world: { width: 9, height: 16 },
  runtime: {
    global: {
      gravity: 9.8,
      initialAmmo: 15,
      explosiveAmmo: 1,
      settleLinearSpeed: 0.12,
      settleAngularSpeed: 0.12,
      settleDurationMs: 1200,
    },
  },
  globalEnvironment: {
    baseWidth: 4.2,
    baseFriction: 0.5,
    baseRestitution: 0.5,
    hillFriction: 0.65,
    hillRestitution: 0.05,
  },
  globalProjectiles: {
    launcher: { totalArcDegrees: 150 },
    meteor: { radius: 0.32, mass: 10, initialDownSpeed: 28, friction: 0.45, restitution: 0.5 },
    explosive: {
      radius: 3,
      maxImpulse: 120,
      damage: 1,
      falloffExponent: 2,
      propagationSpeed: 8,
      meteorRadius: 0.32,
      mass: 10,
      initialDownSpeed: 28,
      friction: 0.45,
      restitution: 0.5,
    },
  },
  globalObjectProfiles: {
    materials: {
      wood: { id: 'wood', name: '木头', mass: 2, friction: 0.55, restitution: 0.55 },
    },
    shapes: {
      circle: { id: 'circle', name: '圆形', shape: { kind: 'circle', radius: 0.25 } },
    },
    explosiveBarrel: {
      id: 'explosive-barrel',
      explosion: { radius: 3, maxImpulse: 120, damage: 1, falloffExponent: 1.5, propagationSpeed: 8 },
    },
  },
  scoreMode: '摧毁城堡目标',
  resourceTheme: '陨石城堡材质与形状',
  unlockRule: '完成前一关后解锁',
  extension: { keep: true },
});

test('decodes the unified global document into detached editor config and assets', () => {
  const source = fixture();
  assert.equal(assertGlobalConfigDocument(source), true);

  const result = decodeGlobalConfig(source);

  assert.equal(result.config.canvas.width, 750);
  assert.equal(result.config.runtime.environment.baseFriction, 0.5);
  assert.equal(result.config.runtime.launcher.totalArcDegrees, 150);
  assert.equal(result.assets.materials.wood.id, 'wood');
  assert.equal(result.assets.specialObjects['explosive-barrel'].explosion.propagationSpeed, 8);
  result.config.runtime.environment.baseFriction = 0.9;
  result.assets.materials.wood.mass = 99;
  assert.equal(source.globalEnvironment.baseFriction, 0.5);
  assert.equal(source.globalObjectProfiles.materials.wood.mass, 2);
});

test('keeps explosiveBarrel at its original document level while exposing the internal special object collection', () => {
  const source = fixture();
  const legacyBarrel = structuredClone(source.globalObjectProfiles.explosiveBarrel);

  const decoded = decodeGlobalConfig(source);

  assert.deepEqual(decoded.assets.specialObjects['explosive-barrel'], {
    id: 'explosive-barrel',
    name: '爆炸桶',
    specialType: 'explosive-barrel',
    shapePresetId: 'square',
    materialId: 'wood',
    ...legacyBarrel,
  });
  assert.deepEqual(decoded.document.globalObjectProfiles.explosiveBarrel, legacyBarrel);
  assert.equal(decoded.document.globalObjectProfiles.specialObjects, undefined);
});

test('encodes edited views into their single authoritative sections', () => {
  const decoded = decodeGlobalConfig(fixture());
  decoded.config.runtime.global.gravity = 12;
  decoded.config.runtime.environment.baseFriction = 0.7;
  decoded.config.runtime.explosive.maxImpulse = 150;
  decoded.assets.materials.wood.mass = 3;

  const output = encodeGlobalConfig(decoded);

  assert.equal(output.runtime.global.gravity, 12);
  assert.equal(output.globalEnvironment.baseFriction, 0.7);
  assert.equal(output.globalProjectiles.explosive.maxImpulse, 150);
  assert.equal(output.globalObjectProfiles.materials.wood.mass, 3);
  assert.deepEqual(output.globalObjectProfiles.explosiveBarrel, decoded.assets.specialObjects['explosive-barrel']);
  assert.equal(output.globalObjectProfiles.specialObjects, undefined);
  assert.deepEqual(output.extension, { keep: true });
  assert.equal(output.runtime.environment, undefined);
  assert.equal(output.runtime.launcher, undefined);
});

test('loads legacy documents without frozenBody using defaults and writes the profile on encode', () => {
  const source = fixture();

  const decoded = decodeGlobalConfig(source);

  assert.deepEqual(decoded.config.runtime.frozenBody, {
    friction: 0.1,
    restitution: 0.2,
    hitSpeedThreshold: 5,
  });
  assert.equal(source.globalObjectProfiles.frozenBody, undefined);

  const output = encodeGlobalConfig(decoded);
  assert.deepEqual(output.globalObjectProfiles.frozenBody, {
    friction: 0.1,
    restitution: 0.2,
    hitSpeedThreshold: 5,
  });
});

test('round-trips edited frozenBody values through the authoritative global object profile', () => {
  const source = fixture();
  source.globalObjectProfiles.frozenBody = {
    friction: 0.3,
    restitution: 0.4,
    hitSpeedThreshold: 6,
  };

  const decoded = decodeGlobalConfig(source);
  decoded.config.runtime.frozenBody.friction = 0.15;
  decoded.config.runtime.frozenBody.hitSpeedThreshold = 7.5;
  const output = encodeGlobalConfig(decoded);
  const reloaded = decodeGlobalConfig(output);

  assert.deepEqual(output.globalObjectProfiles.frozenBody, {
    friction: 0.15,
    restitution: 0.4,
    hitSpeedThreshold: 7.5,
  });
  assert.deepEqual(reloaded.config.runtime.frozenBody, output.globalObjectProfiles.frozenBody);
  assert.equal(output.runtime.frozenBody, undefined);
});

test('rejects invalid frozenBody fields with their precise global profile paths', () => {
  const validProfile = {
    friction: 0.3,
    restitution: 0.4,
    hitSpeedThreshold: 6,
  };
  const invalidCases = [
    ['friction', undefined, 'missing'],
    ['friction', '0.3', 'wrong type'],
    ['friction', Number.NaN, 'NaN'],
    ['friction', Number.POSITIVE_INFINITY, 'positive infinity'],
    ['friction', Number.NEGATIVE_INFINITY, 'negative infinity'],
    ['friction', -0.01, 'negative'],
    ['friction', 1.01, 'greater than one'],
    ['restitution', undefined, 'missing'],
    ['restitution', '0.4', 'wrong type'],
    ['restitution', Number.NaN, 'NaN'],
    ['restitution', Number.POSITIVE_INFINITY, 'positive infinity'],
    ['restitution', Number.NEGATIVE_INFINITY, 'negative infinity'],
    ['restitution', -0.01, 'negative'],
    ['restitution', 1.01, 'greater than one'],
    ['hitSpeedThreshold', undefined, 'missing'],
    ['hitSpeedThreshold', '6', 'wrong type'],
    ['hitSpeedThreshold', Number.NaN, 'NaN'],
    ['hitSpeedThreshold', Number.POSITIVE_INFINITY, 'positive infinity'],
    ['hitSpeedThreshold', Number.NEGATIVE_INFINITY, 'negative infinity'],
    ['hitSpeedThreshold', -0.01, 'negative'],
  ];

  for (const [field, value, label] of invalidCases) {
    const invalid = fixture();
    invalid.globalObjectProfiles.frozenBody = { ...validProfile };
    if (value === undefined) delete invalid.globalObjectProfiles.frozenBody[field];
    else invalid.globalObjectProfiles.frozenBody[field] = value;
    const expectedPath = `globalObjectProfiles.frozenBody.${field}`;
    const hasExpectedPath = error => (
      error instanceof TypeError
      && error.message.startsWith(`${expectedPath} `)
    );

    assert.throws(
      () => assertGlobalConfigDocument(invalid),
      hasExpectedPath,
      `assert should reject ${field}: ${label}`,
    );
    assert.throws(
      () => decodeGlobalConfig(invalid),
      hasExpectedPath,
      `decode should reject ${field}: ${label}`,
    );
  }
});

test('rejects malformed unified global documents with a field path', () => {
  const invalid = fixture();
  delete invalid.globalObjectProfiles.shapes;

  assert.throws(() => assertGlobalConfigDocument(invalid), /globalObjectProfiles\.shapes/);
});

test('save workspace writes one unified global document instead of split files', async () => {
  const globalDocument = JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8'));
  const { config, assets } = decodeGlobalConfig(globalDocument);
  config.runtime.global.gravity = 11;
  assets.materials.wood.mass = 4;
  const writes = new Map();
  const files = {
    async mkdir() {},
    async writeText(path, content) { writes.set(path, content); },
    async remove() {},
  };

  await saveWorkspace({ files, globalDocument, config, assets });

  assert.deepEqual([...writes.keys()], ['全局配置.json']);
  const saved = JSON.parse(writes.get('全局配置.json'));
  assert.equal(saved.runtime.global.gravity, 11);
  assert.equal(saved.globalObjectProfiles.materials.wood.mass, 4);
  assert.equal(writes.has('config.json'), false);
  assert.equal(writes.has('asset.json'), false);
});
