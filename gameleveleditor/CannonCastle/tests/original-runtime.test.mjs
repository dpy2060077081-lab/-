import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as originalRuntimeAdapter from '../static/js/original-runtime-adapter.js';
import { createFrozenBodyStateMachine } from '../static/js/frozen-body-physics.js';
import { projectileVisualShape } from '../static/js/editor.js';

const {
  createOriginalRuntime,
  ORIGINAL_SOURCE_HASH,
  processFrozenDamageEvents,
  resolveRuntimeAssetDefaults,
} = originalRuntimeAdapter;

const level = JSON.parse(await readFile(new URL('../level/关卡-007-爆炸炮弹引导.json', import.meta.url), 'utf8'));
const fixedBoltLevel = JSON.parse(await readFile(new URL('../level/关卡-051-悬栓城门.json', import.meta.url), 'utf8'));
const { assets, config } = await import('./project-config-fixture.mjs');

test('adapter damage processing maps member events, filters speed, and deduplicates one step', () => {
  assert.equal(typeof processFrozenDamageEvents, 'function');
  const groups = [{ id: 'ice-1', memberIds: ['piece-a', 'piece-b'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups, hitSpeedThreshold: 5 });

  processFrozenDamageEvents({
    stateMachine,
    groups,
    eventToken: 'step-1',
    damageEvents: [
      {
        type: 'hit', targetId: 'piece-a', contactId: 'impact-1', relativeSpeed: 4.99, damage: 1,
        position: { x: 1, y: 2 },
      },
      {
        type: 'destroyed', targetId: 'piece-a', contactId: 'impact-1',
        relativeSpeed: 8, position: { x: 3, y: 4 },
      },
      {
        type: 'hit', targetId: 'piece-b', contactId: 'impact-1',
        relativeSpeed: 8, position: { x: 3, y: 4 },
      },
    ],
    explosionEvents: [],
  });

  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a', 'piece-b'], hp: 1, maxHp: 2,
    state: 'cracked', hitPoint: { x: 3, y: 4 },
  });
});

test('adapter damage processing maps the compound group id itself', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a', 'piece-b'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups, hitSpeedThreshold: 5 });

  processFrozenDamageEvents({
    stateMachine,
    groups,
    eventToken: 'step-1',
    damageEvents: [{
      type: 'hit', targetId: 'ice-1', relativeSpeed: 8, position: { x: 3, y: 4 },
    }],
  });

  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a', 'piece-b'], hp: 1, maxHp: 2,
    state: 'cracked', hitPoint: { x: 3, y: 4 },
  });
});

test('damage fallback deduplicates one meteor across members within the same step', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a', 'piece-b'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups });

  processFrozenDamageEvents({
    stateMachine,
    groups,
    eventToken: 'step-1',
    damageEvents: [
      { targetId: 'piece-a', meteor: 'meteor-1', relativeSpeed: 8 },
      { targetId: 'piece-b', meteor: 'meteor-1', relativeSpeed: 8 },
    ],
  });

  assert.equal(stateMachine.snapshot()[0].hp, 1);
});

test('damage fallback keeps two independent untagged impacts in the same step', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups });

  processFrozenDamageEvents({
    stateMachine,
    groups,
    eventToken: 'step-1',
    damageEvents: [
      { targetId: 'ice-1', relativeSpeed: 8 },
      { targetId: 'ice-1', relativeSpeed: 8 },
    ],
  });

  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a'], hp: 0, maxHp: 2,
    state: 'released', hitPoint: null,
  });
});

test('damage fallback counts same-step same-position untagged events independently', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups });

  processFrozenDamageEvents({
    stateMachine,
    groups,
    eventToken: 'step-1',
    damageEvents: [
      { type: 'hit', targetId: 'ice-1', relativeSpeed: 8, position: { x: 1, y: 2 } },
      { type: 'hit', targetId: 'ice-1', relativeSpeed: 8, position: { x: 1, y: 2 } },
    ],
  });

  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a'], hp: 0, maxHp: 2,
    state: 'released', hitPoint: { x: 1, y: 2 },
  });
});

test('damage fallback merges a shared contactId before a distinct contact in the same step', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups });

  processFrozenDamageEvents({
    stateMachine,
    groups,
    eventToken: 'step-1',
    damageEvents: [
      {
        contactId: 'contact-a', targetId: 'ice-1', relativeSpeed: 8,
        position: { x: 1, y: 2 },
      },
      {
        contactId: 'contact-a', targetId: 'ice-1', relativeSpeed: 8,
        position: { x: 5, y: 6 },
      },
      {
        contactId: 'contact-b', targetId: 'ice-1', relativeSpeed: 8,
        position: { x: 3, y: 4 },
      },
    ],
  });

  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a'], hp: 0, maxHp: 2,
    state: 'released', hitPoint: { x: 3, y: 4 },
  });
});

test('damage fallback lets the same meteor cause a new hit in a later step', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups });
  const damageEvents = [{ targetId: 'piece-a', meteor: 'meteor-1', relativeSpeed: 8 }];

  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-1', damageEvents,
  });
  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-2', damageEvents,
  });

  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a'], hp: 0, maxHp: 2,
    state: 'released', hitPoint: null,
  });
});

test('explicit damage contact tokens remain stable across steps', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups });
  const damageEvents = [{
    targetId: 'piece-a', meteor: 'meteor-1', contactToken: 'contact-1', relativeSpeed: 8,
  }];

  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-1', damageEvents,
  });
  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-2', damageEvents,
  });

  assert.equal(stateMachine.snapshot()[0].hp, 1);
});

test('explicit damage contactId remains stable across steps', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups });
  const damageEvents = [{
    targetId: 'piece-a', contactId: 'contact-1', relativeSpeed: 8,
  }];

  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-1', damageEvents,
  });
  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-2', damageEvents: structuredClone(damageEvents),
  });

  assert.equal(stateMachine.snapshot()[0].hp, 1);
});

test('adapter explosion processing uses stable meteor tokens and event speed for group hits', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a', 'piece-b'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups, hitSpeedThreshold: 5 });
  const explosion = {
    type: 'explosion',
    meteor: 'meteor-1',
    speed: 9,
    position: { x: 5, y: 6 },
    hits: [{ targetId: 'piece-a' }, { targetId: 'piece-b' }],
  };

  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-1', damageEvents: [], explosionEvents: [explosion],
  });
  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-2', damageEvents: [], explosionEvents: [explosion],
  });
  assert.equal(stateMachine.snapshot()[0].hp, 1);

  processFrozenDamageEvents({
    stateMachine,
    groups,
    eventToken: 'step-3',
    damageEvents: [],
    explosionEvents: [{ ...explosion, meteor: 'meteor-2' }],
  });
  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a', 'piece-b'], hp: 0, maxHp: 2,
    state: 'released', hitPoint: { x: 5, y: 6 },
  });
});

test('positive explosion damage without a speed field counts once per explosion token', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a', 'piece-b'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups, hitSpeedThreshold: 5 });
  const explosion = {
    type: 'explosion',
    meteor: 'explosive-1',
    explosionToken: 'explosion-1',
    position: { x: 5, y: 6 },
    hits: [{
      targetId: 'ice-1',
      damage: 1,
      impulse: { x: 12, y: -3 },
    }],
  };

  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-1', explosionEvents: [explosion],
  });
  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-2', explosionEvents: [structuredClone(explosion)],
  });

  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a', 'piece-b'], hp: 1, maxHp: 2,
    state: 'cracked', hitPoint: { x: 5, y: 6 },
  });
});

test('explicit explosionId stays stable across steps and counts once per frozen group', () => {
  const groups = [{ id: 'ice-1', memberIds: ['piece-a', 'piece-b'] }];
  const stateMachine = createFrozenBodyStateMachine({ groups, hitSpeedThreshold: 5 });
  const explosionEvents = [{
    type: 'explosion',
    explosionId: 'explosion-1',
    position: { x: 5, y: 6 },
    hits: [
      { targetId: 'piece-a', damage: 1 },
      { targetId: 'piece-b', damage: 1 },
    ],
  }];

  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-1', explosionEvents,
  });
  processFrozenDamageEvents({
    stateMachine, groups, eventToken: 'step-2', explosionEvents: structuredClone(explosionEvents),
  });

  assert.deepEqual(stateMachine.snapshot()[0], {
    id: 'ice-1', memberIds: ['piece-a', 'piece-b'], hp: 1, maxHp: 2,
    state: 'cracked', hitPoint: { x: 5, y: 6 },
  });
});

test('objective reconciliation only replaces frozen members that still exist as original targets', () => {
  assert.equal(typeof originalRuntimeAdapter.reconcileFrozenObjectives, 'function');
  const intact = [{ id: 'ice-1', memberIds: ['a', 'b', 'gone'], state: 'intact' }];
  const removed = [{ id: 'ice-1', memberIds: ['a', 'b', 'gone'], state: 'removed' }];

  assert.deepEqual(
    originalRuntimeAdapter.reconcileFrozenObjectives(
      { remainingTargets: 3, phase: 'playing' },
      intact,
      new Set(['a', 'b', 'ordinary']),
    ),
    { remainingTargets: 2, phase: 'playing' },
  );
  assert.deepEqual(
    originalRuntimeAdapter.reconcileFrozenObjectives(
      { remainingTargets: 1, phase: 'playing' },
      removed,
      new Set(['ordinary']),
    ),
    { remainingTargets: 1, phase: 'playing' },
  );
  assert.deepEqual(
    originalRuntimeAdapter.reconcileFrozenObjectives(
      { remainingTargets: 1, phase: 'playing' },
      intact,
      new Set(['ordinary']),
    ),
    { remainingTargets: 2, phase: 'playing' },
  );
});

test('active compound remains one objective across frames after all member targets are cleaned up', () => {
  const frozenBodies = [{
    id: 'ice-1', memberIds: ['cleaned-a', 'cleaned-b'], state: 'cracked',
  }];

  for (let frame = 0; frame < 2; frame += 1) {
    assert.deepEqual(
      originalRuntimeAdapter.reconcileFrozenObjectives(
        { remainingTargets: 0, phase: 'playing' },
        frozenBodies,
        new Set(),
      ),
      { remainingTargets: 1, phase: 'playing' },
    );
  }
});

test('active frozen objective changes a stale original win back to playing', () => {
  assert.deepEqual(
    originalRuntimeAdapter.reconcileFrozenObjectives(
      { remainingTargets: 0, phase: 'won' },
      [{ id: 'ice-1', memberIds: ['cleaned-a'], state: 'intact' }],
      new Set(),
    ),
    { remainingTargets: 1, phase: 'playing' },
  );
});

test('runs normal and explosive cannon commands through the extracted original session', () => {
  const normal = createOriginalRuntime({ level, assets, config });

  assert.equal(ORIGINAL_SOURCE_HASH, '66bb30e7ed4781d27946482f1464f2734697e6d3');
  assert.deepEqual(normal.snapshot().frozenBodies, []);
  assert.equal(normal.snapshot().normalAmmo, level.level.normalAmmo);
  assert.equal(normal.fireAt({ x: 4.5, y: 4 }), 'fired');
  assert.equal(normal.snapshot().normalAmmo, level.level.normalAmmo - 1);

  const explosive = createOriginalRuntime({ level, assets, config });
  assert.equal(explosive.selectProjectile('explosive'), true);
  assert.equal(explosive.fireAt({ x: 4.5, y: 4 }), 'fired');
  assert.equal(explosive.snapshot().explosiveAmmo, level.level.explosiveAmmo - 1);
  assert.equal(explosive.snapshot().selectedProjectile, 'explosive');
  assert.doesNotThrow(() => explosive.step(16));
  assert.ok(explosive.snapshot().bodies.length >= level.level.castle.length);
  assert.deepEqual(
    explosive.snapshot().bodies.find(({ id }) => id === level.level.castle[0].id).shape,
    assets.shapes[level.level.castle[0].shapePresetId].shape,
  );
});

test('real original compound takes two cannon hits, releases intact members, and resets', () => {
  const targets = [
    {
      id: 'frozen-left', name: 'Frozen left', x: 4.09, y: 12.14, angle: 0,
      shapePresetId: 'rectangle', materialId: 'wood',
    },
    {
      id: 'frozen-right', name: 'Frozen right', x: 4.91, y: 12.14, angle: 0,
      shapePresetId: 'rectangle', materialId: 'wood',
    },
  ];
  const session = createOriginalRuntime({
    level: {
      number: 999,
      normalAmmo: 2,
      explosiveAmmo: 0,
      platformType: 'single-3',
      castle: targets,
      frozenBodies: [{ id: 'ice-1', memberIds: targets.map(target => target.id) }],
    },
    assets,
    config,
  });

  const initial = session.snapshot();
  assert.equal(initial.remainingTargets, 1);
  assert.equal(initial.frozenBodies[0].id, 'ice-1');
  assert.equal(initial.frozenBodies[0].hp, 2);
  assert.equal(initial.frozenBodies[0].state, 'intact');
  assert.ok(Math.abs(initial.frozenBodies[0].mass - 4) < 1e-6);
  assert.equal(initial.frozenBodies[0].memberTransforms.length, 2);
  assert.ok(initial.bodies.some(body => body.id === 'ice-1' && body.kind === 'castle'));

  assert.equal(session.fireAt({ x: 4.5, y: 12.14 }), 'fired');
  let firstHit = null;
  for (let frame = 0; frame < 180 && !firstHit; frame += 1) {
    const snapshot = session.step(16);
    if (snapshot.frozenBodies[0]?.state === 'cracked') firstHit = snapshot;
  }
  assert.ok(firstHit, 'a real original collision should crack the frozen body');
  assert.equal(firstHit.frozenBodies[0].hp, 1);
  assert.equal(firstHit.remainingTargets, 1);
  const originalHit = firstHit.damageEvents.find(event => (
    event.type === 'hit' && event.targetId === 'ice-1'
  ));
  assert.ok(originalHit, 'the original damage system must publish the compound hit');
  assert.equal(originalHit.meteor, null);
  assert.equal(
    firstHit.damageEvents.filter(event => event.type === 'hit' && event.targetId === 'ice-1').length,
    1,
  );
  assert.equal(
    firstHit.damageEvents.some(event => targets.some(target => target.id === event.targetId)),
    false,
  );

  assert.equal(session.fireAt({ x: 4.5, y: 12.14 }), 'fired');
  let secondHit = null;
  for (let frame = 0; frame < 180 && !secondHit; frame += 1) {
    const snapshot = session.step(16);
    if (snapshot.frozenBodies[0]?.state === 'released') secondHit = snapshot;
  }
  assert.ok(secondHit, 'a second meteor should release the frozen body');
  assert.equal(secondHit.frozenBodies[0].hp, 0);
  assert.equal(secondHit.remainingTargets, 2);
  assert.equal(secondHit.bodies.some(body => body.id === 'ice-1'), false);
  for (const target of targets) {
    const member = secondHit.bodies.find(body => body.id === target.id);
    const frozen = secondHit.frozenBodies[0];
    assert.ok(member, `released member ${target.id} must remain in the world`);
    assert.equal(member.hp, assets.materials.wood.maxHp);
    assert.ok(Math.abs(member.vx - (
      frozen.vx - frozen.angularVelocity * (member.y - frozen.y)
    )) < 1e-6);
    assert.ok(Math.abs(member.vy - (
      frozen.vy + frozen.angularVelocity * (member.x - frozen.x)
    )) < 1e-6);
    assert.ok(Math.abs(member.angularVelocity - frozen.angularVelocity) < 1e-6);
  }

  session.reset();
  const reset = session.snapshot();
  assert.equal(reset.frozenBodies[0].hp, 2);
  assert.equal(reset.frozenBodies[0].state, 'intact');
  assert.ok(Math.abs(reset.frozenBodies[0].mass - 4) < 1e-6);
  assert.equal(reset.remainingTargets, 1);
  session.dispose();
  session.dispose();
});

test('runtime uses the editable frozen-body hit threshold from global config', () => {
  const highThresholdConfig = structuredClone(config);
  highThresholdConfig.runtime.frozenBody = {
    friction: 0.1,
    restitution: 0.2,
    hitSpeedThreshold: 1000,
  };
  const session = createOriginalRuntime({
    level: {
      number: 1002,
      normalAmmo: 1,
      explosiveAmmo: 0,
      platformType: 'single-3',
      castle: [{
        id: 'frozen-config-target', name: 'Frozen config target', x: 4.5, y: 12.14, angle: 0,
        shapePresetId: 'rectangle', materialId: 'wood',
      }],
      frozenBodies: [{ id: 'ice-config', memberIds: ['frozen-config-target'] }],
    },
    assets,
    config: highThresholdConfig,
  });

  assert.equal(session.fireAt({ x: 4.5, y: 12.14 }), 'fired');
  let snapshot = session.snapshot();
  for (let frame = 0; frame < 180; frame += 1) snapshot = session.step(16);

  assert.equal(snapshot.frozenBodies[0].state, 'intact');
  assert.equal(snapshot.frozenBodies[0].hp, 2);
  session.dispose();
});

test('real explosive cannon uses the original explosion path for frozen and nearby ordinary targets', () => {
  const frozen = {
    id: 'frozen-center', name: 'Frozen center', x: 4.5, y: 8, angle: 0,
    shapePresetId: 'rectangle', materialId: 'wood',
  };
  const neighbor = {
    id: 'ordinary-neighbor', name: 'Ordinary neighbor', x: 6.2, y: 8, angle: 0,
    shapePresetId: 'rectangle', materialId: 'wood',
  };
  const zeroGravityConfig = structuredClone(config);
  zeroGravityConfig.runtime.global.gravity = 0;
  const frozenSession = createOriginalRuntime({
    level: {
      number: 999,
      normalAmmo: 0,
      explosiveAmmo: 1,
      platformType: 'single-3',
      castle: [frozen, neighbor],
      frozenBodies: [{ id: 'ice-1', memberIds: [frozen.id] }],
    },
    assets,
    config: zeroGravityConfig,
  });
  assert.equal(frozenSession.selectProjectile('explosive'), true);
  assert.equal(frozenSession.fireAt({ x: frozen.x, y: frozen.y }), 'fired');

  const frozenEvents = [];
  let frozenSnapshot = null;
  for (let frame = 0; frame < 180; frame += 1) {
    frozenSnapshot = frozenSession.step(16);
    frozenEvents.push(...frozenSnapshot.explosionEvents);
    const hitIds = new Set(frozenEvents.flatMap(event => event.hits ?? []).map(hit => hit.targetId));
    if (hitIds.has('ice-1') && hitIds.has(neighbor.id)) break;
  }

  const frozenHits = frozenEvents.flatMap(event => event.hits ?? []);
  const compoundHit = frozenHits.find(hit => hit.targetId === 'ice-1');
  const neighborHit = frozenHits.find(hit => hit.targetId === neighbor.id);
  assert.ok(compoundHit, 'the original explosion event must include the frozen compound');
  assert.ok(neighborHit, 'the original explosion wave must include the nearby ordinary target');
  assert.equal(frozenEvents.some(event => Object.hasOwn(event, 'explosionToken')), false);
  assert.equal(frozenSnapshot.frozenBodies[0].hp, 1);
  assert.equal(frozenSnapshot.frozenBodies[0].state, 'cracked');
  assert.equal(
    frozenEvents.flatMap(event => event.hits ?? []).filter(hit => hit.targetId === 'ice-1').length,
    1,
  );
  assert.ok(Math.hypot(compoundHit.impulse.x, compoundHit.impulse.y) > 0);
  assert.ok(Math.hypot(frozenSnapshot.frozenBodies[0].vx, frozenSnapshot.frozenBodies[0].vy) > 0);
  assert.equal(frozenSnapshot.bodies.find(body => body.id === frozen.id).hp, assets.materials.wood.maxHp);
  assert.ok(Math.hypot(
    frozenSnapshot.bodies.find(body => body.id === neighbor.id).vx,
    frozenSnapshot.bodies.find(body => body.id === neighbor.id).vy,
  ) > 0);
  assert.equal(
    frozenSnapshot.bodies.find(body => body.id === neighbor.id).hp,
    assets.materials.wood.maxHp - neighborHit.damage,
  );

  const referenceTarget = { ...frozen, id: 'ordinary-center', name: 'Ordinary center' };
  const referenceNeighbor = { ...neighbor, id: 'ordinary-neighbor-reference' };
  const referenceSession = createOriginalRuntime({
    level: {
      number: 1000,
      normalAmmo: 0,
      explosiveAmmo: 1,
      platformType: 'single-3',
      castle: [referenceTarget, referenceNeighbor],
    },
    assets,
    config: zeroGravityConfig,
  });
  assert.equal(referenceSession.selectProjectile('explosive'), true);
  assert.equal(referenceSession.fireAt({ x: referenceTarget.x, y: referenceTarget.y }), 'fired');
  const referenceEvents = [];
  for (let frame = 0; frame < 180; frame += 1) {
    const snapshot = referenceSession.step(16);
    referenceEvents.push(...snapshot.explosionEvents);
    if (referenceEvents.flatMap(event => event.hits ?? [])
      .some(hit => hit.targetId === referenceNeighbor.id)) break;
  }
  const referenceNeighborHit = referenceEvents.flatMap(event => event.hits ?? [])
    .find(hit => hit.targetId === referenceNeighbor.id);
  assert.ok(referenceNeighborHit);
  assert.equal(neighborHit.damage, referenceNeighborHit.damage);
  assert.ok(Math.abs(neighborHit.impulse.x - referenceNeighborHit.impulse.x) < 1e-6);
  assert.ok(Math.abs(neighborHit.impulse.y - referenceNeighborHit.impulse.y) < 1e-6);
  frozenSession.dispose();
  referenceSession.dispose();
});

test('removed frozen group does not hide a surviving ordinary target across later frames', () => {
  const session = createOriginalRuntime({
    level: {
      number: 1001,
      normalAmmo: 1,
      explosiveAmmo: 0,
      platformType: 'single-3',
      castle: [
        {
          id: 'outside-frozen', name: 'Outside frozen', x: -3, y: 8, angle: 0,
          shapePresetId: 'rectangle', materialId: 'wood',
        },
        {
          id: 'ordinary-survivor', name: 'Ordinary survivor', x: 4.5, y: 10, angle: 0,
          shapePresetId: 'rectangle', materialId: 'stone', fixedBolt: true,
        },
      ],
      frozenBodies: [{ id: 'ice-outside', memberIds: ['outside-frozen'] }],
    },
    assets,
    config,
  });

  for (let frame = 0; frame < 2; frame += 1) {
    const snapshot = session.step(16);
    assert.equal(snapshot.frozenBodies[0].state, 'removed');
    assert.equal(snapshot.bodies.some(body => body.id === 'ordinary-survivor'), true);
    assert.equal(snapshot.remainingTargets, 1);
    assert.equal(snapshot.phase, 'playing');
  }
  session.dispose();
});

test('fired projectiles match the Demo physics radius and launch speed', () => {
  assert.deepEqual(config.runtime.meteor, {
    radius: 0.32,
    mass: 10,
    initialDownSpeed: 28,
    friction: 0.45,
    restitution: 0.5,
  });
  const session = createOriginalRuntime({ level, assets, config });
  assert.equal(session.fireAt({ x: 4.5, y: 4 }), 'fired');

  const projectile = session.snapshot().projectiles.find(body => body.meteorType || body.kind === 'meteor');
  assert.ok(projectile, 'a fired meteor must appear in the snapshot');
  assert.equal(projectile.radius, config.runtime.meteor.radius);
  assert.ok(
    Math.abs(Math.hypot(projectile.vx, projectile.vy) - config.runtime.meteor.initialDownSpeed) < 1e-6,
    'launch speed must equal the Demo initialDownSpeed',
  );
});

test('preserves original out-of-arc and reset behavior and owns the input level', () => {
  const input = structuredClone(level);
  const session = createOriginalRuntime({ level: input, assets, config });

  assert.equal(session.fireAt({ x: 4.5, y: -2 }), 'out-of-arc');
  assert.equal(session.snapshot().normalAmmo, level.level.normalAmmo);
  session.fireAt({ x: 4.5, y: 4 });
  session.reset();
  assert.equal(session.snapshot().normalAmmo, level.level.normalAmmo);
  assert.deepEqual(input, level);
});

test('dispose is idempotent and rejects subsequent commands', () => {
  const session = createOriginalRuntime({ level, assets, config });
  session.dispose();
  session.dispose();
  assert.throws(() => session.step(16), (error) => error?.code === 'SESSION_DISPOSED');
});

test('runtime resolves global material defaults before explicit object overrides without mutating drafts', () => {
  const inheritedLevel = structuredClone(level);
  const inheritedObject = inheritedLevel.level.castle.find(object => object.materialId === 'wood');
  delete inheritedObject.friction;
  const input = structuredClone(inheritedLevel);
  const changedAssets = structuredClone(assets);
  changedAssets.materials.wood.friction = 0.91;

  const inheritedSession = createOriginalRuntime({ level: input, assets: changedAssets, config });
  assert.equal(inheritedSession.snapshot().bodies.find(body => body.id === inheritedObject.id).friction, 0.91);
  assert.deepEqual(input, inheritedLevel);
  assert.equal(Object.hasOwn(input.level.castle.find(object => object.id === inheritedObject.id), 'friction'), false);

  const overrideLevel = structuredClone(inheritedLevel);
  overrideLevel.level.castle.find(object => object.id === inheritedObject.id).friction = 0.23;
  const overrideSession = createOriginalRuntime({ level: overrideLevel, assets: changedAssets, config });
  assert.equal(overrideSession.snapshot().bodies.find(body => body.id === inheritedObject.id).friction, 0.23);
});

test('runtime inherits special fixedBolt without persisting it and lets an instance override win', () => {
  const specialAssets = structuredClone(assets);
  specialAssets.specialObjects['explosive-barrel'].fixedBolt = true;
  const draft = {
    castle: [{
      id: 'barrel-a', name: 'Barrel', x: 1, y: 2, angle: 0,
      materialId: 'wood', shapePresetId: 'square', specialType: 'explosive-barrel',
      shape: structuredClone(assets.shapes.square.shape),
    }],
  };

  const inherited = resolveRuntimeAssetDefaults(draft, specialAssets);
  assert.equal(inherited.castle[0].fixedBolt, true);
  assert.equal(Object.hasOwn(draft.castle[0], 'fixedBolt'), false);

  const overridden = structuredClone(draft);
  overridden.castle[0].fixedBolt = false;
  assert.equal(resolveRuntimeAssetDefaults(overridden, specialAssets).castle[0].fixedBolt, false);
});

test('explosive impacts publish cloneable hit snapshots and keep stepping after detonation', () => {
  const session = createOriginalRuntime({ level, assets, config });
  const target = level.level.castle[0];
  assert.equal(session.selectProjectile('explosive'), true);
  assert.equal(session.fireAt({ x: target.x, y: target.y }), 'fired');

  let detonation = null;
  for (let frame = 0; frame < 120 && !detonation; frame += 1) {
    const snapshot = session.step(16);
    if (snapshot.explosionEvents.length > 0) detonation = snapshot;
  }

  assert.ok(detonation, 'the real Demo runtime should detonate on the aimed castle object');
  assert.doesNotThrow(() => structuredClone(detonation));
  assert.equal(detonation.projectiles.length, 0);
  for (const hit of detonation.explosionEvents[0].hits) {
    assert.ok(hit.target === null || typeof hit.target === 'string');
    assert.ok(hit.targetId === null || typeof hit.targetId === 'string');
    assert.deepEqual(Object.keys(hit).sort(), ['damage', 'impulse', 'target', 'targetId']);
  }
  assert.doesNotThrow(() => session.step(16));
  session.dispose();
});

test('runtime snapshots include fixed static castle objects without exporting environment bodies', () => {
  const session = createOriginalRuntime({ level: fixedBoltLevel, assets, config });
  const snapshotIds = new Set(session.snapshot().bodies.map(({ id }) => id));
  const castleIds = fixedBoltLevel.level.castle.map(({ id }) => id);

  assert.deepEqual(castleIds.filter(id => !snapshotIds.has(id)), []);
  for (const object of fixedBoltLevel.level.castle.filter(({ fixedBolt }) => fixedBolt === true)) {
    assert.equal(snapshotIds.has(object.id), true);
  }
  assert.equal(session.snapshot().bodies.filter(({ id }) => castleIds.includes(id)).length, castleIds.length);
  session.dispose();
});

test('normal meteor destroys a destructible fixed-bolt piece using the original material contract', () => {
  const target = {
    id: 'fixed-glass', name: 'Fixed glass', x: 4.5, y: 10.4, angle: 0,
    shapePresetId: 'long-thin-rectangle', materialId: 'glass', fixedBolt: true,
  };
  const session = createOriginalRuntime({
    level: {
      number: 999,
      normalAmmo: 1,
      explosiveAmmo: 0,
      platformType: 'single-3',
      castle: [target],
    },
    assets,
    config,
  });

  assert.equal(session.fireAt(target), 'fired');
  let destroyed = false;
  for (let frame = 0; frame < 180 && !destroyed; frame += 1) {
    const snapshot = session.step(16);
    destroyed = snapshot.damageEvents.some(event => event.type === 'destroyed' && event.targetId === target.id);
  }

  assert.equal(destroyed, true, 'a bolted glass piece must still receive impact damage');
  assert.equal(session.snapshot().bodies.some(body => body.id === target.id), false);
  session.dispose();
});

test('rendering input derivation preserves the original runtime projectile radius', () => {
  const runtimeProjectile = Object.freeze({
    kind: 'meteor',
    radius: 0.2,
    shape: Object.freeze({ kind: 'circle', radius: 0.2 }),
  });

  assert.deepEqual(projectileVisualShape(runtimeProjectile), { kind: 'circle', radius: 0.4 });
  assert.equal(runtimeProjectile.radius, 0.2);
  assert.equal(runtimeProjectile.shape.radius, 0.2);
});

test('runtime snapshots preserve every field consumed by the original play frame', () => {
  const session = createOriginalRuntime({ level, assets, config });
  for (const snapshot of [session.snapshot(), session.step(16)]) {
    assert.equal(Number.isFinite(snapshot.launcherAngleDegrees), true);
    assert.equal(typeof snapshot.phase, 'string');
    assert.equal(Number.isFinite(snapshot.remainingTargets), true);
    assert.equal(Number.isFinite(snapshot.normalAmmo), true);
    assert.equal(Number.isFinite(snapshot.explosiveAmmo), true);
  }
  session.dispose();
});
