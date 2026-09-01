const MAX_HP = 2;

function cloneHitPoint(point) {
  return point == null ? null : { ...point };
}

function toSnapshot(group) {
  return {
    id: group.id,
    memberIds: [...group.memberIds],
    hp: group.hp,
    maxHp: MAX_HP,
    state: group.state,
    hitPoint: cloneHitPoint(group.hitPoint),
  };
}

export function createFrozenBodyStateMachine({ groups = [], hitSpeedThreshold = 5 } = {}) {
  const stateGroups = (Array.isArray(groups) ? groups : []).map((source) => ({
    id: source?.id,
    memberIds: Array.isArray(source?.memberIds) ? [...source.memberIds] : [],
    hp: MAX_HP,
    state: 'intact',
    hitPoint: null,
    hitTokens: new Set(),
  }));
  const groupsById = new Map(stateGroups.map((group) => [group.id, group]));

  function requireGroup(groupId) {
    const group = groupsById.get(groupId);
    if (!group) {
      throw new Error(`Unknown frozen body group: ${groupId}`);
    }
    return group;
  }

  function hit(groupId, { speed, token, point }) {
    const group = requireGroup(groupId);
    if (
      group.state === 'released'
      || group.state === 'removed'
      || !Number.isFinite(speed)
      || speed < hitSpeedThreshold
      || group.hitTokens.has(token)
    ) {
      return toSnapshot(group);
    }

    group.hitTokens.add(token);
    group.hp -= 1;
    group.state = group.hp === 1 ? 'cracked' : 'released';
    group.hitPoint = cloneHitPoint(point);
    return toSnapshot(group);
  }

  function releaseMotion(groupId, {
    x,
    y,
    vx,
    vy,
    angularVelocity,
    members,
  }) {
    const group = requireGroup(groupId);
    if (group.state !== 'released') {
      throw new Error(`Frozen body group ${groupId} must be released before releasing motion`);
    }

    return members.map((member) => ({
      id: member.id,
      vx: vx - angularVelocity * (member.y - y),
      vy: vy + angularVelocity * (member.x - x),
      angularVelocity,
    }));
  }

  function snapshot() {
    return stateGroups.map(toSnapshot);
  }

  function reset() {
    for (const group of stateGroups) {
      group.hp = MAX_HP;
      group.state = 'intact';
      group.hitPoint = null;
      group.hitTokens.clear();
    }
  }

  function remove(groupId) {
    const group = requireGroup(groupId);
    if (group.state !== 'released') group.state = 'removed';
    return toSnapshot(group);
  }

  return { hit, releaseMotion, snapshot, reset, remove };
}

const DEFAULT_FROZEN_PROFILE = Object.freeze({
  friction: 0.1,
  restitution: 0.2,
  hitSpeedThreshold: 5,
});

function bodiesById(world) {
  const result = new Map();
  for (let body = world.getBodyList(); body; body = body.getNext()) {
    const id = body.getUserData?.()?.id;
    if (id != null) result.set(id, body);
  }
  return result;
}

function fixturesOf(body) {
  const fixtures = [];
  for (let fixture = body.getFixtureList(); fixture; fixture = fixture.getNext()) fixtures.push(fixture);
  return fixtures;
}

function fixtureMass(fixture) {
  const center = fixture.getBody().getLocalCenter().clone();
  const massData = { mass: 0, center, I: 0 };
  fixture.getMassData(massData);
  return massData.mass;
}

function cloneFixtureShapeAtBody(fixture, sourceBody, targetBody) {
  const sourceShape = fixture.getShape();
  const shape = sourceShape._clone();
  if (sourceShape.getType() === 'circle') {
    const worldCenter = sourceBody.getWorldPoint(sourceShape.getCenter());
    shape.m_p.set(targetBody.getLocalPoint(worldCenter));
    return shape;
  }
  if (sourceShape.getType() === 'polygon') {
    const vertices = sourceShape.m_vertices.map(vertex => (
      targetBody.getLocalPoint(sourceBody.getWorldPoint(vertex))
    ));
    shape._set(vertices);
    return shape;
  }
  throw new Error(`Unsupported frozen fixture shape: ${sourceShape.getType()}`);
}

function fixtureOptions(fixture, density, profile) {
  return {
    density,
    friction: profile.friction,
    restitution: profile.restitution,
    filterCategoryBits: fixture.getFilterCategoryBits(),
    filterMaskBits: fixture.getFilterMaskBits(),
    filterGroupIndex: fixture.getFilterGroupIndex(),
  };
}

function compoundKinematics(record) {
  const body = record.compound;
  const position = body.getPosition();
  const velocity = body.getLinearVelocity();
  return {
    x: position.x,
    y: position.y,
    angle: body.getAngle(),
    vx: velocity.x,
    vy: velocity.y,
    angularVelocity: body.getAngularVelocity(),
    mass: body.getMass(),
    memberTransforms: record.members.map(({ id, localPosition, localAngle }) => {
      const memberPosition = body.getWorldPoint(localPosition);
      return {
        id,
        x: memberPosition.x,
        y: memberPosition.y,
        angle: body.getAngle() + localAngle,
      };
    }),
  };
}

function bodyIsInWorld(world, expected) {
  for (let body = world.getBodyList(); body; body = body.getNext()) {
    if (body === expected) return true;
  }
  return false;
}

export function createFrozenCompoundController({
  world,
  groups = [],
  originalObjects = new Map(),
  profile: profileInput = {},
  stateMachine,
} = {}) {
  if (!world) throw new TypeError('world is required');
  if (!stateMachine) throw new TypeError('stateMachine is required');
  const profile = { ...DEFAULT_FROZEN_PROFILE, ...profileInput };
  const groupSources = (Array.isArray(groups) ? groups : []).map(group => ({
    id: group.id,
    memberIds: [...(group.memberIds ?? [])],
  }));
  const initialBodies = bodiesById(world);
  const initialMembers = new Map();
  let records = [];
  const pendingRemovedGroups = [];
  let disposed = false;

  for (const group of groupSources) {
    for (const id of group.memberIds) {
      const body = initialBodies.get(id);
      if (!body) throw new Error(`Frozen body member not found in world: ${id}`);
      if (!initialMembers.has(id)) {
        const position = body.getPosition();
        const velocity = body.getLinearVelocity();
        initialMembers.set(id, {
          body,
          x: position.x,
          y: position.y,
          angle: body.getAngle(),
          vx: velocity.x,
          vy: velocity.y,
          angularVelocity: body.getAngularVelocity(),
          destructible: body.getUserData()?.destructible,
        });
      }
    }
  }

  function createRecord(group) {
    const memberBodies = (group.memberIds ?? []).map((id) => {
      const body = initialMembers.get(id)?.body;
      if (!body) throw new Error(`Frozen body member not found in world: ${id}`);
      return { id, body, mass: body.getMass() };
    });
    const totalMass = memberBodies.reduce((sum, member) => sum + member.mass, 0);
    if (!(totalMass > 0)) throw new Error(`Frozen body group has no positive mass: ${group.id}`);
    const centroid = memberBodies.reduce((point, member) => {
      const center = member.body.getWorldCenter();
      point.x += center.x * member.mass / totalMass;
      point.y += center.y * member.mass / totalMass;
      return point;
    }, { x: 0, y: 0 });
    const shape = {
      kind: 'compound',
      memberIds: [...(group.memberIds ?? [])],
      members: (group.memberIds ?? []).map(id => originalObjects.get(id)?.shape).filter(Boolean),
    };
    const compound = world.createDynamicBody({
      position: centroid,
      angle: 0,
      userData: {
        id: group.id,
        kind: 'castle',
        frozenBody: true,
        frozenBodyId: group.id,
        shape,
        maxHp: MAX_HP,
        hp: MAX_HP,
        destructible: true,
        hitSpeedThreshold: profile.hitSpeedThreshold,
      },
    });
    const members = memberBodies.map((member) => ({
      ...member,
      localPosition: compound.getLocalPoint(member.body.getPosition()).clone(),
      localAngle: member.body.getAngle() - compound.getAngle(),
    }));

    for (const member of members) {
      const fixtures = fixturesOf(member.body);
      const sourceMass = fixtures.reduce((sum, fixture) => sum + fixtureMass(fixture), 0);
      const densityScale = sourceMass > 0 ? member.mass / sourceMass : 0;
      for (const fixture of fixtures) {
        const clonedShape = cloneFixtureShapeAtBody(fixture, member.body, compound);
        compound.createFixture(
          clonedShape,
          fixtureOptions(fixture, fixture.getDensity() * densityScale, profile),
        );
      }
    }
    for (const member of members) {
      const data = member.body.getUserData();
      if (data) data.destructible = false;
      member.body.setActive(false);
    }
    const record = { id: group.id, compound, members, finalKinematics: null };
    record.lastKinematics = compoundKinematics(record);
    return record;
  }

  function destroyCompound(record) {
    if (bodyIsInWorld(world, record.compound)) world.destroyBody(record.compound);
  }

  function captureRecord(record) {
    record.lastKinematics = compoundKinematics(record);
    return record.lastKinematics;
  }

  function restoreMembers(record, kinematics) {
    destroyCompound(record);
    const transforms = new Map(kinematics.memberTransforms.map(transform => [transform.id, transform]));
    for (const member of record.members) {
      if (!bodyIsInWorld(world, member.body)) continue;
      const transform = transforms.get(member.id);
      if (!transform) continue;
      const data = member.body.getUserData();
      if (data) data.destructible = initialMembers.get(member.id)?.destructible;
      member.body.setTransform({ x: transform.x, y: transform.y }, transform.angle);
      member.body.setActive(true);
      member.body.setLinearVelocity({
        x: kinematics.vx - kinematics.angularVelocity * (transform.y - kinematics.y),
        y: kinematics.vy + kinematics.angularVelocity * (transform.x - kinematics.x),
      });
      member.body.setAngularVelocity(kinematics.angularVelocity);
    }
  }

  function releaseRecord(record) {
    if (record.finalKinematics) return;
    const kinematics = captureRecord(record);
    record.finalKinematics = structuredClone(kinematics);
    restoreMembers(record, kinematics);
  }

  function rebuild() {
    records = groupSources.map(createRecord);
  }

  rebuild();

  function afterStep() {
    if (disposed) return;
    const states = new Map(stateMachine.snapshot().map(state => [state.id, state]));
    for (const record of records) {
      const state = states.get(record.id);
      const data = record.compound.getUserData?.();
      if (data && state) {
        data.hp = state.hp;
        data.state = state.state;
      }
      if (state?.state === 'released') releaseRecord(record);
      else if (state?.state === 'removed') continue;
      else if (!bodyIsInWorld(world, record.compound)) {
        if (!record.finalKinematics) record.finalKinematics = structuredClone(record.lastKinematics);
        const removed = stateMachine.remove(record.id);
        if (data) {
          data.hp = removed.hp;
          data.state = removed.state;
        }
        pendingRemovedGroups.push({
          id: record.id,
          members: record.members.map(member => member.body),
        });
      } else captureRecord(record);
    }
  }

  function snapshot() {
    const states = new Map(stateMachine.snapshot().map(state => [state.id, state]));
    return records.map((record) => {
      const state = states.get(record.id);
      if (!record.finalKinematics) captureRecord(record);
      return { ...state, ...structuredClone(record.finalKinematics ?? record.lastKinematics) };
    });
  }

  function reset() {
    if (disposed) return;
    for (const record of records) destroyCompound(record);
    for (const initial of initialMembers.values()) {
      initial.body.setActive(true);
      initial.body.setTransform({ x: initial.x, y: initial.y }, initial.angle);
      initial.body.setLinearVelocity({ x: initial.vx, y: initial.vy });
      initial.body.setAngularVelocity(initial.angularVelocity);
      const data = initial.body.getUserData();
      if (data) data.destructible = initial.destructible;
    }
    stateMachine.reset();
    pendingRemovedGroups.splice(0);
    rebuild();
  }

  function dispose() {
    if (disposed) return;
    for (const record of records) {
      if (!record.finalKinematics) restoreMembers(record, captureRecord(record));
      else destroyCompound(record);
    }
    pendingRemovedGroups.splice(0);
    disposed = true;
  }

  return {
    beforeStep() {
      if (disposed) return;
    },
    afterStep,
    consumeRemovedGroups() {
      return pendingRemovedGroups.splice(0);
    },
    snapshot,
    reset,
    dispose,
  };
}
