import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blackHoleForce,
  createOriginalRuntime,
  isProjectileReboundWall,
  splitDirections,
} from '../static/js/original-runtime-adapter.js';
import { decodeGlobalConfig, encodeGlobalConfig } from '../static/js/global-config-document.js';

test('split projectile creates left, forward and right circular launch directions', () => {
  const directions = splitDirections({ x: 0, y: 9 }, 45);
  assert.equal(directions.length, 3);
  assert.deepEqual(directions[1], { x: 0, y: 1 });
  assert.ok(directions[0].x > 0 && directions[2].x < 0);
  directions.forEach(direction => assert.ok(Math.abs(Math.hypot(direction.x, direction.y) - 1) < 1e-9));
});

test('black hole force contains inward and tangential force and orbit fades at consume edge', () => {
  const config = { consumeRadius: 1, attractionRadius: 5, attractionForce: 12, orbitForce: 18 };
  const force = blackHoleForce({ x: 4, y: 0 }, { x: 0, y: 0 }, config);
  assert.ok(force.x < 0, 'force pulls inward');
  assert.ok(force.y < 0, 'force has a counter-clockwise tangent');
  const edge = blackHoleForce({ x: 1.000001, y: 0 }, { x: 0, y: 0 }, config);
  assert.ok(Math.abs(edge.y) < 0.00001, 'orbit force fades at consume edge');
});

test('original projectile wall metadata is recognized as a rebound surface', () => {
  assert.equal(isProjectileReboundWall({ kind: 'environment', environmentRole: 'projectile-wall' }), true);
  assert.equal(isProjectileReboundWall({ kind: 'castle', environmentRole: 'target' }), false);
});

test('legacy global config fills special defaults and preserves them on round trip', async () => {
  const source = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../全局配置.json', import.meta.url), 'utf8'));
  delete source.globalProjectiles.split;
  delete source.globalProjectiles.blackHole;
  const decoded = decodeGlobalConfig(source);
  assert.equal(decoded.config.runtime.split.splitCount, 3);
  assert.equal(decoded.config.runtime.blackHole.orbitForce, 18);
  const encoded = encodeGlobalConfig({ document: decoded.document, config: decoded.config, assets: decoded.assets });
  assert.equal(encoded.globalProjectiles.split.childMass, 5);
  assert.equal(encoded.globalProjectiles.blackHole.attractionRadius, 3.5);
});

test('special inventory selects, fires, decrements and resets independently', async () => {
  const level = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  level.level.splitAmmo = 4;
  level.level.blackHoleAmmo = 2;
  const { config, assets } = await import('./project-config-fixture.mjs');
  const runtime = createOriginalRuntime({ level, config, assets });
  assert.equal(runtime.snapshot().splitAmmo, 4);
  assert.equal(runtime.snapshot().blackHoleAmmo, 2);
  assert.equal(runtime.selectProjectile('split'), true);
  assert.equal(runtime.fireAt({ x: 4.5, y: 8 }), 'fired');
  assert.equal(runtime.snapshot().splitAmmo, 3);
  assert.equal(runtime.snapshot().selectedProjectile, 'split');
  runtime.reset();
  assert.equal(runtime.snapshot().splitAmmo, 4);
  assert.equal(runtime.snapshot().blackHoleAmmo, 2);
  runtime.dispose();
});

test('missing special ammo fields default to zero instead of granting placeholder inventory', async () => {
  const level = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  delete level.level.splitAmmo;
  delete level.level.blackHoleAmmo;
  const { config, assets } = await import('./project-config-fixture.mjs');
  const runtime = createOriginalRuntime({ level, config, assets });
  assert.equal(runtime.snapshot().splitAmmo, 0);
  assert.equal(runtime.snapshot().blackHoleAmmo, 0);
  assert.equal(runtime.selectProjectile('split'), true);
  assert.equal(runtime.fireAt({ x: 4.5, y: 8 }), 'blocked');
  runtime.dispose();
});

test('split and black-hole projectiles can be fired repeatedly while earlier shots remain active', async () => {
  const source = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  const { config, assets } = await import('./project-config-fixture.mjs');

  for (const [type, ammoField] of [['split', 'splitAmmo'], ['blackHole', 'blackHoleAmmo']]) {
    const level = structuredClone(source);
    level.level[ammoField] = 3;
    const runtime = createOriginalRuntime({ level, config, assets });
    runtime.selectProjectile(type);
    assert.equal(runtime.fireAt({ x: 4.5, y: 8 }), 'fired');
    assert.equal(runtime.fireAt({ x: 4.5, y: 8 }), 'fired');
    assert.equal(runtime.snapshot()[ammoField], 1);
    runtime.dispose();
  }
});

test('split impact removes main projectile and creates three circular non-recursive children', async () => {
  const level = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  level.level.splitAmmo = 1;
  const { config, assets } = await import('./project-config-fixture.mjs');
  const runtime = createOriginalRuntime({ level, config, assets });
  runtime.selectProjectile('split');
  runtime.fireAt({ x: 4.5, y: 8 });
  let snapshot;
  for (let frame = 0; frame < 300; frame += 1) {
    snapshot = runtime.step(1000 / 60);
    if (snapshot.projectiles.some(projectile => projectile.type === 'splitChild')) break;
  }
  const children = snapshot.projectiles.filter(projectile => projectile.type === 'splitChild');
  assert.equal(children.length, 3);
  assert.equal(snapshot.projectiles.some(projectile => projectile.type === 'split'), false);
  children.forEach(child => assert.equal(child.radius, config.runtime.split.childRadius));
  assert.equal(snapshot.specialEffects.some(effect => effect.type === 'splitFlash'), true);
  runtime.dispose();
});

test('a sleeping split child is no longer an active special projectile', async () => {
  const adapter = await import('../static/js/original-runtime-adapter.js');
  assert.equal(typeof adapter.isSpecialProjectileActive, 'function');
  const body = { isAwake: () => false };
  assert.equal(adapter.isSpecialProjectileActive({ body, type: 'splitChild' }, () => true), false);
});

test('black-hole impact removes shell, persists independently, then expires', async () => {
  const level = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  level.level.blackHoleAmmo = 1;
  const { config, assets } = await import('./project-config-fixture.mjs');
  const runtime = createOriginalRuntime({ level, config, assets });
  runtime.selectProjectile('blackHole');
  runtime.fireAt({ x: 4.5, y: 8 });
  let snapshot;
  for (let frame = 0; frame < 300; frame += 1) {
    snapshot = runtime.step(1000 / 60);
    if (snapshot.blackHoles.length) break;
  }
  assert.equal(snapshot.projectiles.some(projectile => projectile.type === 'blackHole'), false);
  assert.equal(snapshot.blackHoles.length, 1);
  for (let elapsed = 0; elapsed < 3100; elapsed += 100) snapshot = runtime.step(100);
  assert.equal(snapshot.blackHoles.length, 0);
  runtime.dispose();
});

test('split and black-hole projectiles trigger when impact destroys an already damaged object', async () => {
  const source = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  const { config, assets } = await import('./project-config-fixture.mjs');

  for (const [type, effectPresent] of [
    ['split', snapshot => snapshot.projectiles.some(projectile => projectile.type === 'splitChild')],
    ['blackHole', snapshot => snapshot.blackHoles.length > 0],
  ]) {
    const level = structuredClone(source);
    level.level.castle = [{
      id: `damaged-${type}`,
      name: '破损木块',
      x: 4.5,
      y: 8,
      angle: 0,
      shapePresetId: 'rectangle',
      materialId: 'wood',
      maxHp: 2,
    }];
    level.level[`${type}Ammo`] = 1;
    const runtime = createOriginalRuntime({ level, config, assets });
    runtime.selectProjectile('normal');
    assert.equal(runtime.fireAt({ x: 4.5, y: 8 }), 'fired');
    let damagedSnapshot;
    for (let frame = 0; frame < 300; frame += 1) {
      damagedSnapshot = runtime.step(1000 / 60);
      if (damagedSnapshot.bodies.some(body => body.id === `damaged-${type}` && body.hp === 1)) break;
    }
    assert.equal(
      damagedSnapshot.bodies.some(body => body.id === `damaged-${type}` && body.hp === 1),
      true,
      'precondition: the first impact must leave the object damaged and present',
    );

    runtime.selectProjectile(type);
    assert.equal(runtime.fireAt({ x: 4.5, y: 8 }), 'fired');

    let snapshot;
    for (let frame = 0; frame < 300; frame += 1) {
      snapshot = runtime.step(1000 / 60);
      if (effectPresent(snapshot)) break;
    }

    assert.equal(effectPresent(snapshot), true, `${type} must trigger on a destroyed damaged object`);
    runtime.dispose();
  }
});
