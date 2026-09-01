import assert from 'node:assert/strict';
import test from 'node:test';

import { OriginalGameSession } from '../static/vendor/meteor-original-runtime.js';
import {
  createFrozenBodyStateMachine,
  createFrozenCompoundController,
} from '../static/js/frozen-body-physics.js';
import { assets, config } from './project-config-fixture.mjs';

function runtimeObject(id, x, shapePresetId, materialId, angle = 0) {
  const material = assets.materials[materialId];
  return {
    id,
    name: id,
    x,
    y: 8,
    angle,
    materialId,
    shapePresetId,
    shape: structuredClone(assets.shapes[shapePresetId].shape),
    mass: material.mass,
    friction: material.friction,
    restitution: material.restitution,
    color: material.color,
    destructible: material.destructible,
    maxHp: material.maxHp,
    hitSpeedThreshold: material.hitSpeedThreshold,
  };
}

function createCompoundFixture() {
  const castle = [
    runtimeObject('piece-box', 4, 'rectangle', 'wood', 0.2),
    runtimeObject('piece-circle', 4.82, 'circle', 'stone'),
    runtimeObject('piece-polygon', 5.45, 'isosceles-triangle', 'glass', -0.15),
  ];
  const level = {
    ...structuredClone(config.runtime),
    global: { ...structuredClone(config.runtime.global), gravity: 0 },
    environment: { ...structuredClone(config.runtime.environment), platformType: 'single-3' },
    objectProfiles: { materials: structuredClone(assets.materials) },
    castle,
  };
  const engine = new OriginalGameSession(level);
  const groups = [{ id: 'ice-1', memberIds: castle.map(object => object.id) }];
  const stateMachine = createFrozenBodyStateMachine({ groups, hitSpeedThreshold: 5 });
  const originalObjects = new Map(castle.map(object => [object.id, structuredClone(object)]));
  const world = engine.physics.getWorld();
  const controller = createFrozenCompoundController({
    world,
    groups,
    originalObjects,
    profile: { friction: 0.1, restitution: 0.2, hitSpeedThreshold: 5 },
    stateMachine,
  });
  return { engine, world, groups, stateMachine, controller };
}

function bodyById(world, id) {
  for (let body = world.getBodyList(); body; body = body.getNext()) {
    if (body.getUserData?.()?.id === id) return body;
  }
  return null;
}

function fixturesOf(body) {
  const fixtures = [];
  for (let fixture = body?.getFixtureList?.(); fixture; fixture = fixture.getNext()) fixtures.push(fixture);
  return fixtures;
}

function assertPointClose(actual, expected, message) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `${message} x`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `${message} y`);
}

function sortedPoints(points) {
  return [...points].sort((left, right) => left.x - right.x || left.y - right.y);
}

function transformedPoint(point, transform) {
  const cosine = Math.cos(transform.angle);
  const sine = Math.sin(transform.angle);
  return {
    x: transform.x + point.x * cosine - point.y * sine,
    y: transform.y + point.x * sine + point.y * cosine,
  };
}

function createMachine() {
  return createFrozenBodyStateMachine({
    groups: [
      { id: 'ice-1', memberIds: ['piece-a', 'piece-b'] },
      { id: 'ice-2', memberIds: ['piece-c'] },
    ],
    hitSpeedThreshold: 5,
  });
}

test('starts every group intact with two HP and returns deep-cloned snapshots', () => {
  const machine = createMachine();
  const first = machine.snapshot();

  assert.deepEqual(first, [
    {
      id: 'ice-1',
      memberIds: ['piece-a', 'piece-b'],
      hp: 2,
      maxHp: 2,
      state: 'intact',
      hitPoint: null,
    },
    {
      id: 'ice-2',
      memberIds: ['piece-c'],
      hp: 2,
      maxHp: 2,
      state: 'intact',
      hitPoint: null,
    },
  ]);

  first[0].memberIds.push('mutated');
  first[0].hitPoint = { x: 99, y: 99 };

  assert.deepEqual(machine.snapshot()[0], {
    id: 'ice-1',
    memberIds: ['piece-a', 'piece-b'],
    hp: 2,
    maxHp: 2,
    state: 'intact',
    hitPoint: null,
  });
});

test('ignores slow hits without consuming their token', () => {
  const machine = createMachine();

  assert.deepEqual(machine.hit('ice-1', {
    speed: 4.99,
    token: 'contact-1',
    point: { x: 1, y: 2 },
  }), {
    id: 'ice-1',
    memberIds: ['piece-a', 'piece-b'],
    hp: 2,
    maxHp: 2,
    state: 'intact',
    hitPoint: null,
  });

  assert.equal(machine.hit('ice-1', {
    speed: 5,
    token: 'contact-1',
    point: { x: 3, y: 4 },
  }).hp, 1);
});

test('uses five as the default hit-speed threshold', () => {
  const machine = createFrozenBodyStateMachine({
    groups: [{ id: 'ice-1', memberIds: ['piece-a'] }],
  });

  assert.equal(machine.hit('ice-1', {
    speed: 4.99,
    token: 'contact-1',
    point: { x: 0, y: 0 },
  }).hp, 2);
  assert.equal(machine.hit('ice-1', {
    speed: 5,
    token: 'contact-1',
    point: { x: 0, y: 0 },
  }).hp, 1);
});

test('ignores non-finite hit speeds', () => {
  for (const [index, speed] of [NaN, Infinity, -Infinity].entries()) {
    const machine = createFrozenBodyStateMachine({
      groups: [{ id: 'ice-1', memberIds: ['piece-a'] }],
    });

    assert.equal(machine.hit('ice-1', {
      speed,
      token: `invalid-${index}`,
      point: { x: 1, y: 2 },
    }).hp, 2);
  }
});

test('defaults missing groups to an empty array', () => {
  let machine;
  assert.doesNotThrow(() => {
    machine = createFrozenBodyStateMachine({});
  });
  assert.deepEqual(machine.snapshot(), []);
});

test('defaults missing memberIds to an empty array', () => {
  let machine;
  assert.doesNotThrow(() => {
    machine = createFrozenBodyStateMachine({ groups: [{ id: 'ice-1' }] });
  });
  assert.deepEqual(machine.snapshot(), [{
    id: 'ice-1', memberIds: [], hp: 2, maxHp: 2, state: 'intact', hitPoint: null,
  }]);
});

test('deduplicates a token per group and releases on a second distinct token', () => {
  const machine = createMachine();

  assert.deepEqual(machine.hit('ice-1', {
    speed: 7,
    token: 'hit-1',
    point: { x: 10, y: 20 },
  }), {
    id: 'ice-1',
    memberIds: ['piece-a', 'piece-b'],
    hp: 1,
    maxHp: 2,
    state: 'cracked',
    hitPoint: { x: 10, y: 20 },
  });

  assert.equal(machine.hit('ice-1', {
    speed: 9,
    token: 'hit-1',
    point: { x: 30, y: 40 },
  }).hp, 1);
  assert.equal(machine.hit('ice-2', {
    speed: 9,
    token: 'hit-1',
    point: { x: 50, y: 60 },
  }).hp, 1);

  assert.deepEqual(machine.hit('ice-1', {
    speed: 8,
    token: 'hit-2',
    point: { x: 30, y: 40 },
  }), {
    id: 'ice-1',
    memberIds: ['piece-a', 'piece-b'],
    hp: 0,
    maxHp: 2,
    state: 'released',
    hitPoint: { x: 30, y: 40 },
  });
});

test('returns independent hit snapshots and does not damage a released group again', () => {
  const machine = createMachine();
  const point = { x: 1, y: 2 };
  const cracked = machine.hit('ice-1', { speed: 6, token: 'hit-1', point });

  point.x = 100;
  cracked.memberIds.push('mutated');
  cracked.hitPoint.y = 200;

  machine.hit('ice-1', { speed: 6, token: 'hit-2', point: { x: 3, y: 4 } });
  const released = machine.hit('ice-1', {
    speed: 20,
    token: 'hit-3',
    point: { x: 5, y: 6 },
  });

  assert.deepEqual(released, {
    id: 'ice-1',
    memberIds: ['piece-a', 'piece-b'],
    hp: 0,
    maxHp: 2,
    state: 'released',
    hitPoint: { x: 3, y: 4 },
  });
});

test('releaseMotion applies rigid-body linear and angular velocity to each member', () => {
  const machine = createMachine();
  machine.hit('ice-1', { speed: 6, token: 'hit-1', point: { x: 0, y: 0 } });
  machine.hit('ice-1', { speed: 6, token: 'hit-2', point: { x: 0, y: 0 } });

  assert.deepEqual(machine.releaseMotion('ice-1', {
    x: 10,
    y: 20,
    vx: 3,
    vy: 4,
    angularVelocity: 2,
    members: [
      { id: 'piece-a', x: 8, y: 19 },
      { id: 'piece-b', x: 13, y: 24 },
    ],
  }), [
    { id: 'piece-a', vx: 5, vy: 0, angularVelocity: 2 },
    { id: 'piece-b', vx: -5, vy: 10, angularVelocity: 2 },
  ]);
});

test('releaseMotion rejects groups that have not been released', () => {
  const machine = createMachine();

  assert.throws(() => machine.releaseMotion('ice-1', {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angularVelocity: 0,
    members: [],
  }), /released/);
});

test('reset restores HP, state, hit point, and token eligibility', () => {
  const machine = createMachine();
  machine.hit('ice-1', { speed: 6, token: 'reusable', point: { x: 1, y: 2 } });
  machine.reset();

  assert.deepEqual(machine.snapshot()[0], {
    id: 'ice-1',
    memberIds: ['piece-a', 'piece-b'],
    hp: 2,
    maxHp: 2,
    state: 'intact',
    hitPoint: null,
  });
  assert.equal(machine.hit('ice-1', {
    speed: 6,
    token: 'reusable',
    point: { x: 3, y: 4 },
  }).hp, 1);
});

test('builds one real compound from member fixtures without an outer AABB', () => {
  const { world, controller } = createCompoundFixture();
  const compound = bodyById(world, 'ice-1');
  const memberIds = ['piece-box', 'piece-circle', 'piece-polygon'];
  const originalFixtureCount = memberIds.reduce(
    (count, id) => count + fixturesOf(bodyById(world, id)).length,
    0,
  );
  const compoundFixtures = fixturesOf(compound);

  assert.ok(compound, 'the real OriginalGameSession world must contain the compound');
  assert.equal(compound.getUserData().kind, 'castle');
  assert.equal(compound.getUserData().frozenBody, true);
  assert.equal(compound.getUserData().frozenBodyId, 'ice-1');
  assert.equal(compoundFixtures.length, originalFixtureCount);
  assert.deepEqual(
    compoundFixtures.map(fixture => fixture.getShape().getType()).sort(),
    ['circle', 'polygon', 'polygon'],
  );
  assert.ok(Math.abs(compound.getMass() - 10.2) < 1e-6);
  assert.ok(Math.abs(controller.snapshot()[0].mass - 10.2) < 1e-6);
  for (const fixture of compoundFixtures) {
    assert.equal(fixture.getFriction(), 0.1);
    assert.equal(fixture.getRestitution(), 0.2);
  }
  for (const id of memberIds) assert.equal(bodyById(world, id).isActive(), false);
});

test('cloned circle centers and polygon vertices keep the same world geometry after compound motion', () => {
  const { world, controller } = createCompoundFixture();
  const compound = bodyById(world, 'ice-1');
  compound.setTransform({ x: 6, y: 7 }, 0.43);
  controller.afterStep();
  const visualTransforms = new Map(controller.snapshot()[0].memberTransforms.map(transform => (
    [transform.id, transform]
  )));

  const compoundFixtures = fixturesOf(compound);
  const circleMember = bodyById(world, 'piece-circle');
  const sourceCircle = fixturesOf(circleMember)[0].getShape();
  const compoundCircle = compoundFixtures.find(fixture => fixture.getShape().getType() === 'circle')
    .getShape();
  assertPointClose(
    compound.getWorldPoint(compoundCircle.getCenter()),
    transformedPoint(sourceCircle.getCenter(), visualTransforms.get('piece-circle')),
    'circle center',
  );

  for (const memberId of ['piece-box', 'piece-polygon']) {
    const member = bodyById(world, memberId);
    const sourceShape = fixturesOf(member)[0].getShape();
    const compoundShape = compoundFixtures
      .map(fixture => fixture.getShape())
      .find(shape => shape.getType() === 'polygon' && shape.m_count === sourceShape.m_count);
    assert.ok(compoundShape, `compound polygon for ${memberId}`);
    const expected = sortedPoints(sourceShape.m_vertices.map(vertex => (
      transformedPoint(vertex, visualTransforms.get(memberId))
    )));
    const actual = sortedPoints(compoundShape.m_vertices.map(vertex => compound.getWorldPoint(vertex)));
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < actual.length; index += 1) {
      assertPointClose(actual[index], expected[index], `${memberId} vertex ${index}`);
    }
  }
});

test('parks inactive members while snapshots follow the compound, then releases them at derived transforms', () => {
  const { engine, world, stateMachine, controller } = createCompoundFixture();
  const compound = bodyById(world, 'ice-1');
  const memberIds = ['piece-box', 'piece-circle', 'piece-polygon'];
  const originalHp = new Map(memberIds.map(id => [id, bodyById(world, id).getUserData().hp]));
  const parkedTransforms = new Map(memberIds.map(id => {
    const member = bodyById(world, id);
    return [id, { x: member.getPosition().x, y: member.getPosition().y, angle: member.getAngle() }];
  }));
  compound.setTransform({ x: 9.2, y: 7 }, 0.4);

  controller.beforeStep();
  engine.update(16);
  compound.setLinearVelocity({ x: 3, y: 4 });
  compound.setAngularVelocity(2);
  controller.afterStep();
  const grouped = controller.snapshot()[0];
  for (const transform of grouped.memberTransforms) {
    const member = bodyById(world, transform.id);
    const parked = parkedTransforms.get(transform.id);
    assert.equal(member.isActive(), false);
    assertPointClose(member.getPosition(), parked, `${transform.id} parked position`);
    assert.ok(Math.abs(member.getAngle() - parked.angle) < 1e-9);
    assert.ok(Math.abs(transform.x - parked.x) > 1, `${transform.id} visual transform follows compound`);
  }

  stateMachine.hit('ice-1', { speed: 8, token: 'hit-1', point: { x: 9.2, y: 7 } });
  controller.afterStep();
  assert.ok(bodyById(world, 'ice-1'), 'the first hit must keep the compound active');
  assert.equal(compound.getUserData().hp, 1);
  assert.equal(compound.getUserData().state, 'cracked');
  for (const id of memberIds) {
    assert.equal(bodyById(world, id).isActive(), false);
    assert.equal(bodyById(world, id).getUserData().hp, originalHp.get(id));
  }

  const derivedTransforms = new Map(controller.snapshot()[0].memberTransforms.map(transform => (
    [transform.id, transform]
  )));
  stateMachine.hit('ice-1', { speed: 8, token: 'hit-2', point: { x: 9.4, y: 7.1 } });
  assert.doesNotThrow(() => controller.afterStep());
  assert.doesNotThrow(() => controller.afterStep());
  assert.equal(bodyById(world, 'ice-1'), null);
  for (const id of memberIds) {
    const member = bodyById(world, id);
    const position = member.getPosition();
    const velocity = member.getLinearVelocity();
    const derived = derivedTransforms.get(id);
    assert.equal(member.isActive(), true);
    assertPointClose(position, derived, `${id} released position`);
    assert.ok(Math.abs(member.getAngle() - derived.angle) < 1e-9);
    assert.ok(Math.abs(velocity.x - (3 - 2 * (position.y - 7))) < 1e-9);
    assert.ok(Math.abs(velocity.y - (4 + 2 * (position.x - 9.2))) < 1e-9);
    assert.equal(member.getAngularVelocity(), 2);
    assert.equal(member.getUserData().hp, originalHp.get(id));
  }
  const released = controller.snapshot()[0];
  assert.equal(released.state, 'released');
  assert.equal(released.x, 9.2);
  assert.equal(released.y, 7);
  assert.equal(released.vx, 3);
  assert.equal(released.vy, 4);
  assert.equal(released.angularVelocity, 2);
});

test('released group reads final kinematics from a compound already destroyed from the world', () => {
  const { world, stateMachine, controller } = createCompoundFixture();
  const compound = bodyById(world, 'ice-1');
  const memberIds = ['piece-box', 'piece-circle', 'piece-polygon'];
  const relativeTransforms = new Map(memberIds.map((id) => {
    const member = bodyById(world, id);
    return [id, {
      position: compound.getLocalPoint(member.getPosition()).clone(),
      angle: member.getAngle() - compound.getAngle(),
    }];
  }));
  const finalPosition = { x: 7, y: 6 };
  const finalAngle = 0.6;
  const finalVelocity = { x: 5, y: -2 };
  const finalAngularVelocity = -1.5;

  compound.setTransform(finalPosition, finalAngle);
  compound.setLinearVelocity(finalVelocity);
  compound.setAngularVelocity(finalAngularVelocity);
  world.destroyBody(compound);
  stateMachine.hit('ice-1', { speed: 8, token: 'hit-1', point: finalPosition });
  stateMachine.hit('ice-1', { speed: 8, token: 'hit-2', point: finalPosition });
  controller.afterStep();

  const released = controller.snapshot()[0];
  assert.equal(released.state, 'released');
  assert.equal(released.x, finalPosition.x);
  assert.equal(released.y, finalPosition.y);
  assert.equal(released.angle, finalAngle);
  assert.equal(released.vx, finalVelocity.x);
  assert.equal(released.vy, finalVelocity.y);
  assert.equal(released.angularVelocity, finalAngularVelocity);
  assert.deepEqual(controller.consumeRemovedGroups(), []);
  for (const id of memberIds) {
    const member = bodyById(world, id);
    const relative = relativeTransforms.get(id);
    const expectedPosition = compound.getWorldPoint(relative.position);
    const position = member.getPosition();
    const velocity = member.getLinearVelocity();
    assert.equal(member.isActive(), true);
    assertPointClose(position, expectedPosition, `${id} final position`);
    assert.ok(Math.abs(member.getAngle() - (finalAngle + relative.angle)) < 1e-9);
    assert.ok(Math.abs(velocity.x - (
      finalVelocity.x - finalAngularVelocity * (position.y - finalPosition.y)
    )) < 1e-9);
    assert.ok(Math.abs(velocity.y - (
      finalVelocity.y + finalAngularVelocity * (position.x - finalPosition.x)
    )) < 1e-9);
    assert.equal(member.getAngularVelocity(), finalAngularVelocity);
  }
});

test('reset rebuilds an intact compound and dispose restores members idempotently', () => {
  const { world, stateMachine, controller } = createCompoundFixture();
  stateMachine.hit('ice-1', { speed: 8, token: 'hit-1', point: { x: 1, y: 2 } });
  stateMachine.hit('ice-1', { speed: 8, token: 'hit-2', point: { x: 3, y: 4 } });
  controller.afterStep();

  assert.doesNotThrow(() => controller.reset());
  assert.doesNotThrow(() => controller.reset());
  assert.equal(controller.snapshot()[0].state, 'intact');
  assert.ok(bodyById(world, 'ice-1'));
  for (const id of ['piece-box', 'piece-circle', 'piece-polygon']) {
    assert.equal(bodyById(world, id).isActive(), false);
  }

  assert.doesNotThrow(() => controller.dispose());
  assert.doesNotThrow(() => controller.dispose());
  assert.equal(bodyById(world, 'ice-1'), null);
  for (const id of ['piece-box', 'piece-circle', 'piece-polygon']) {
    assert.equal(bodyById(world, id).isActive(), true);
  }
});

test('marks an externally removed compound cleared and queues its inactive members for cleanup', () => {
  const { world, controller } = createCompoundFixture();
  const compound = bodyById(world, 'ice-1');
  world.destroyBody(compound);

  controller.afterStep();
  const removed = controller.snapshot()[0];
  assert.equal(removed.state, 'removed');
  assert.equal(removed.hp, 2);
  assert.equal(bodyById(world, 'ice-1'), null);
  const removals = controller.consumeRemovedGroups();
  assert.equal(removals.length, 1);
  assert.equal(removals[0].id, 'ice-1');
  assert.deepEqual(
    removals[0].members.map(member => member.getUserData().id).sort(),
    ['piece-box', 'piece-circle', 'piece-polygon'],
  );
  for (const member of removals[0].members) assert.equal(member.isActive(), false);
  assert.deepEqual(controller.consumeRemovedGroups(), []);
});
