import {
  OriginalGameSession,
  ORIGINAL_SOURCE_HASH,
  originalAimAtTarget,
} from '../vendor/meteor-original-runtime.js';
import { decodeLevelDocument } from './level-document.js';
import {
  createFrozenBodyStateMachine,
  createFrozenCompoundController,
} from './frozen-body-physics.js';

export { ORIGINAL_SOURCE_HASH };

export function isProjectileReboundWall(data = {}) {
  return ['projectile-wall', 'rebound-wall'].includes(data.kind)
    || data.type === 'projectile-wall'
    || data.environmentRole === 'projectile-wall';
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function mergeGlobal(level, globalPhysics) {
  const next = clone(level);
  if (!globalPhysics) return next;
  for (const key of ['global', 'meteor', 'explosive', 'split', 'blackHole', 'launcher', 'environment', 'objectProfiles']) {
    if (globalPhysics[key] !== undefined) next[key] = clone(globalPhysics[key]);
  }
  return next;
}

const RUNTIME_OBJECT_DEFAULT_FIELDS = [
  'mass', 'friction', 'restitution', 'color', 'destructible', 'maxHp', 'hitSpeedThreshold', 'fixedBolt',
];

function definedFields(source, fields = RUNTIME_OBJECT_DEFAULT_FIELDS) {
  return Object.fromEntries(fields.filter(field => source?.[field] !== undefined).map(field => [field, clone(source[field])]));
}

export function resolveRuntimeAssetDefaults(level, assets = {}) {
  assets ??= {};
  const next = clone(level);
  next.castle = (next.castle ?? []).map(object => {
    const material = assets.materials?.[object.materialId] ?? {};
    const special = assets.specialObjects?.[object.specialType] ?? {};
    const shape = object.shape ?? assets.shapes?.[object.shapePresetId]?.shape;
    return {
      ...definedFields(material),
      ...definedFields(special, [...RUNTIME_OBJECT_DEFAULT_FIELDS, 'explosion']),
      ...clone(object),
      ...(shape ? { shape: clone(shape) } : {}),
    };
  });
  return next;
}

function buildRuntimeLevel(level, { config, assets, globalPhysics } = {}) {
  level = decodeLevelDocument(level, assets);
  let next = resolveRuntimeAssetDefaults(mergeGlobal(level, globalPhysics), assets);
  const physics = config?.runtime ?? config?.physics ?? config;
  if (physics && typeof physics === 'object') next = mergeGlobal(next, physics);
  if (physics?.frozenBody && typeof physics.frozenBody === 'object') {
    next.objectProfiles ??= {};
    next.objectProfiles.frozenBody = clone(physics.frozenBody);
  }
  if (Number.isFinite(level.normalAmmo)) next.global = { ...(next.global || {}), initialAmmo: level.normalAmmo };
  if (Number.isFinite(level.explosiveAmmo)) next.global = { ...(next.global || {}), explosiveAmmo: level.explosiveAmmo };
  if (level.platformType) next.environment = { ...(next.environment || {}), platformType: level.platformType };
  if (assets?.materials) {
    next.objectProfiles ??= {};
    next.objectProfiles.materials = clone(assets.materials);
  }
  const barrel = assets?.specialObjects?.['explosive-barrel'] ?? assets?.explosiveBarrel;
  if (barrel) {
    next.objectProfiles ??= {};
    next.objectProfiles.explosiveBarrel = clone(barrel);
  }
  next.objectProfiles ??= {};
  next.objectProfiles.materials ??= {};
  next.castle = (next.castle ?? []).map((object, index) => {
    if (!object.materialId) return object;
    const originalMaterialId = object.materialId;
    const runtimeMaterialId = `__runtime-object-${index}-${object.id}`;
    next.objectProfiles.materials[runtimeMaterialId] = {
      // The original Demo derives destructibility from the material profile's
      // own canonical id. Keep the synthetic map key private to the adapter,
      // but preserve wood/glass here so its damage contract remains intact.
      id: originalMaterialId,
      name: object.name ?? runtimeMaterialId,
      ...definedFields(object),
    };
    return { ...object, materialId: runtimeMaterialId };
  });
  return next;
}

function bodySnapshot(body, originalObjects) {
  const data = body.getUserData?.() ?? {};
  const original = originalObjects.get(data.id) ?? {};
  const position = body.getPosition();
  const velocity = body.getLinearVelocity();
  const fixture = body.getFixtureList?.();
  const fixtureShape = fixture?.getShape?.();
  return {
    id: data.id ?? null,
    kind: data.kind ?? data.type ?? (data.isMeteor ? 'meteor' : 'body'),
    meteorType: data.meteorType ?? null,
    x: position.x,
    y: position.y,
    angle: body.getAngle(),
    vx: velocity.x,
    vy: velocity.y,
    angularVelocity: body.getAngularVelocity(),
    velocity: { x: velocity.x, y: velocity.y },
    hp: data.hp ?? data.maxHp ?? null,
    maxHp: data.maxHp ?? null,
    mass: body.getMass?.() ?? original.mass ?? null,
    friction: fixture?.getFriction?.() ?? original.friction ?? null,
    restitution: fixture?.getRestitution?.() ?? original.restitution ?? null,
    destructible: data.destructible ?? original.destructible ?? null,
    hitSpeedThreshold: data.hitSpeedThreshold ?? original.hitSpeedThreshold ?? null,
    shape: clone(data.shape ?? original.shape ?? null),
    color: data.color ?? original.color ?? null,
    radius: data.radius ?? data.shape?.radius
      ?? (fixtureShape?.getType?.() === "circle" ? fixtureShape.getRadius() : null)
      ?? original.shape?.radius ?? null,
    position: { x: position.x, y: position.y },
    type: data.meteorType ?? data.type ?? null,
  };
}

function eventSnapshot(event) {
  const hits = Array.isArray(event.hits) ? event.hits.map((hit) => {
    const targetId = hit.target?.getUserData?.()?.id ?? hit.targetId ?? null;
    return {
      target: targetId,
      targetId,
      impulse: {
        x: Number(hit.impulse?.x ?? 0),
        y: Number(hit.impulse?.y ?? 0),
      },
      damage: Number(hit.damage ?? 0),
    };
  }) : event.hits;
  return {
    ...event,
    target: event.target?.getUserData?.()?.id ?? event.target?.id ?? null,
    meteor: event.meteor?.getUserData?.()?.id ?? null,
    ...(event.position ? { position: { x: Number(event.position.x), y: Number(event.position.y) } } : {}),
    ...(hits !== undefined ? { hits } : {}),
  };
}

function eventObjectId(value) {
  if (typeof value === 'string') return value;
  return value?.getUserData?.()?.id ?? value?.id ?? null;
}

function vectorSpeed(vector) {
  if (!vector || !Number.isFinite(Number(vector.x)) || !Number.isFinite(Number(vector.y))) return null;
  return Math.hypot(Number(vector.x), Number(vector.y));
}

export function splitDirections(forward, angleDegrees = 45) {
  const speed = Math.hypot(Number(forward?.x), Number(forward?.y));
  const unit = speed > 1e-6 ? { x: forward.x / speed, y: forward.y / speed } : { x: 0, y: 1 };
  const rotate = degrees => {
    const radians = degrees * Math.PI / 180;
    return { x: unit.x * Math.cos(radians) - unit.y * Math.sin(radians), y: unit.x * Math.sin(radians) + unit.y * Math.cos(radians) };
  };
  return [rotate(-angleDegrees), unit, rotate(angleDegrees)];
}

export function isSpecialProjectileActive(projectile, isCurrentBody) {
  if (!isCurrentBody(projectile.body)) return false;
  if (projectile.type !== 'splitChild') return true;
  return projectile.body?.isAwake?.() !== false;
}

export function blackHoleForce(position, center, config) {
  const dx = Number(center.x) - Number(position.x);
  const dy = Number(center.y) - Number(position.y);
  const distance = Math.hypot(dx, dy);
  if (!(distance > config.consumeRadius && distance <= config.attractionRadius)) return { x: 0, y: 0 };
  const inward = { x: dx / distance, y: dy / distance };
  const orbitStrength = Math.max(0, Math.min(1, (distance - config.consumeRadius) / (config.attractionRadius - config.consumeRadius)));
  return {
    x: inward.x * config.attractionForce - inward.y * config.orbitForce * orbitStrength,
    y: inward.y * config.attractionForce + inward.x * config.orbitForce * orbitStrength,
  };
}

function eventSpeed(event) {
  for (const value of [event?.relativeSpeed, event?.impactSpeed, event?.speed]) {
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return vectorSpeed(event?.velocity)
    ?? vectorSpeed(event?.meteor?.getLinearVelocity?.())
    ?? vectorSpeed(event?.meteor?.velocity)
    ?? 0;
}

function eventSourceToken(event, fallback) {
  const explicit = event?.contactToken ?? event?.explosionToken ?? event?.eventToken
    ?? event?.token ?? event?.eventId ?? event?.id;
  if (explicit !== undefined && explicit !== null) return explicit;
  if (event?.explosionId !== undefined && event?.explosionId !== null) {
    return `explosion:${event.explosionId}`;
  }
  const meteorId = eventObjectId(event?.meteor);
  return meteorId ? `meteor:${meteorId}` : fallback;
}

function damageSourceToken(event, stepToken, eventIndex) {
  const explicit = event?.contactToken ?? event?.eventToken ?? event?.token
    ?? event?.eventId ?? event?.id;
  if (explicit !== undefined && explicit !== null) return explicit;
  if (event?.contactId !== undefined && event?.contactId !== null) {
    return `contact:${event.contactId}`;
  }
  const meteorId = eventObjectId(event?.meteor);
  if (meteorId) return `${stepToken}:meteor:${meteorId}`;
  return `${stepToken}:damage:${eventIndex}`;
}

export function processFrozenDamageEvents({
  stateMachine,
  groups,
  damageEvents = [],
  explosionEvents = [],
  eventToken,
}) {
  const membership = new Map();
  for (const group of groups ?? []) {
    membership.set(group.id, group.id);
    for (const memberId of group.memberIds ?? []) membership.set(memberId, group.id);
  }

  const applyHit = (targetId, event, source, token, effectiveExplosionDamage = false) => {
    const groupId = membership.get(targetId);
    if (!groupId) return;
    stateMachine.hit(groupId, {
      speed: effectiveExplosionDamage ? Number.MAX_VALUE : eventSpeed(source) || eventSpeed(event),
      token,
      point: source?.position ?? event?.position ?? null,
    });
  };

  for (const [index, event] of (damageEvents ?? []).entries()) {
    applyHit(
      event?.targetId ?? eventObjectId(event?.target),
      event,
      event,
      damageSourceToken(event, eventToken, index),
    );
  }
  for (const [index, event] of (explosionEvents ?? []).entries()) {
    const token = eventSourceToken(event, `${eventToken}:explosion:${index}`);
    for (const hit of event?.hits ?? []) {
      applyHit(
        hit?.targetId ?? eventObjectId(hit?.target),
        { ...event, token },
        hit,
        token,
        Number(hit?.damage) > 0,
      );
    }
  }
  return stateMachine.snapshot();
}

function renderingBodies(physics, originalObjects) {
  const bodies = [];
  for (let body = physics.getWorld().getBodyList(); body; body = body.getNext()) {
    const id = body.getUserData?.()?.id;
    if (body.isDynamic() || originalObjects.has(id)) bodies.push(body);
  }
  return bodies;
}

function disposedError() {
  return Object.assign(new Error('Original runtime session has been disposed'), { code: 'SESSION_DISPOSED' });
}

export function reconcileFrozenObjectives(original, frozenBodies = [], currentTargetIds = null) {
  const targetIds = currentTargetIds instanceof Set ? currentTargetIds : null;
  let remainingTargets = targetIds
    ? targetIds.size
    : Math.max(0, Number(original?.remainingTargets ?? 0));
  for (const group of frozenBodies) {
    if (!['intact', 'cracked'].includes(group.state)) continue;
    const existingMemberCount = targetIds
      ? (group.memberIds ?? []).filter(id => targetIds.has(id)).length
      : (group.memberIds?.length ?? 0);
    remainingTargets -= existingMemberCount;
    remainingTargets += 1;
  }
  remainingTargets = Math.max(0, remainingTargets);
  const canComplete = remainingTargets === 0 && ['playing', 'settling'].includes(original?.phase);
  const phase = remainingTargets > 0 && original?.phase === 'won'
    ? 'playing'
    : canComplete ? 'won' : original?.phase;
  return {
    remainingTargets,
    phase,
  };
}

export function createOriginalRuntime({ level, config, assets, globalPhysics } = {}) {
  if (!level || typeof level !== 'object') throw new TypeError('level is required');
  const initialLevel = buildRuntimeLevel(level, { config, assets, globalPhysics });
  const originalObjects = new Map((initialLevel.castle ?? []).map(object => [object.id, clone(object)]));
  const frozenGroups = Array.isArray(initialLevel.frozenBodies) ? clone(initialLevel.frozenBodies) : [];
  const frozenProfile = {
    friction: Number.isFinite(initialLevel.objectProfiles?.frozenBody?.friction)
      ? initialLevel.objectProfiles.frozenBody.friction : 0.1,
    restitution: Number.isFinite(initialLevel.objectProfiles?.frozenBody?.restitution)
      ? initialLevel.objectProfiles.frozenBody.restitution : 0.2,
    hitSpeedThreshold: Number.isFinite(initialLevel.objectProfiles?.frozenBody?.hitSpeedThreshold)
      ? initialLevel.objectProfiles.frozenBody.hitSpeedThreshold : 5,
  };
  const frozenStateMachine = createFrozenBodyStateMachine({
    groups: frozenGroups,
    hitSpeedThreshold: frozenProfile.hitSpeedThreshold,
  });
  let engine = new OriginalGameSession(initialLevel);
  let frozenController = createFrozenCompoundController({
    world: engine.physics.getWorld(),
    groups: frozenGroups,
    originalObjects,
    profile: frozenProfile,
    stateMachine: frozenStateMachine,
  });
  let frozenEventSequence = 0;
  const specialAmmoStart = Object.freeze({
    split: Number.isInteger(initialLevel.splitAmmo) && initialLevel.splitAmmo >= 0 ? initialLevel.splitAmmo : 0,
    blackHole: Number.isInteger(initialLevel.blackHoleAmmo) && initialLevel.blackHoleAmmo >= 0 ? initialLevel.blackHoleAmmo : 0,
  });
  let specialAmmo = { ...specialAmmoStart };
  let selectedProjectile = 'normal';
  let specialProjectiles = [];
  let blackHoles = [];
  let specialEffects = [];
  let disposed = false;

  const active = () => {
    if (disposed) throw disposedError();
  };

  const flushFrozenRemovals = () => {
    for (const removal of frozenController.consumeRemovedGroups()) {
      for (const member of removal.members) engine.physics.destroyBody(member);
    }
  };

  const spawnConfiguredProjectile = (direction, type, projectileConfig, position = null) => {
    const originalMeteorConfig = engine.physics.getConfig().meteor;
    engine.physics.getConfig().meteor = {
      radius: projectileConfig.radius,
      mass: projectileConfig.mass,
      initialDownSpeed: projectileConfig.initialDownSpeed,
      friction: projectileConfig.friction,
      restitution: projectileConfig.restitution,
    };
    let body;
    try { body = engine.physics.spawnMeteor(direction, 'normal'); }
    finally { engine.physics.getConfig().meteor = originalMeteorConfig; }
    const data = body.getUserData();
    body.setUserData({ ...data, meteorType: type, color: type === 'split' || type === 'splitChild' ? '#37c7d9' : '#7b4ce2', radius: projectileConfig.radius });
    if (position) body.setPosition({ x: position.x, y: position.y });
    body.setLinearVelocity({ x: direction.x * projectileConfig.initialDownSpeed, y: direction.y * projectileConfig.initialDownSpeed });
    return body;
  };

  const touchingNonWall = body => {
    for (let edge = body?.getContactList?.(); edge; edge = edge.next) {
      const contact = edge.contact;
      if (!contact?.isTouching?.()) continue;
      const other = edge.other;
      const data = other?.getUserData?.() ?? {};
      if (data.kind === 'meteor' || data.isMeteor || data.meteorType) continue;
      if (isProjectileReboundWall(data)) continue;
      return true;
    }
    return false;
  };

  const activateSplit = projectile => {
    const body = projectile.body;
    const position = { ...body.getPosition() };
    const velocity = body.getLinearVelocity();
    engine.physics.destroyBody(body);
    const split = initialLevel.split;
    specialEffects.push({ type: 'splitFlash', position, remainingMs: 260 });
    for (const direction of splitDirections(velocity, split.splitAngleDegrees)) {
      const child = spawnConfiguredProjectile(direction, 'splitChild', {
        radius: split.childRadius, mass: split.childMass, initialDownSpeed: split.childSpeed,
        friction: split.friction, restitution: split.restitution,
      }, position);
      specialProjectiles.push({ body: child, type: 'splitChild', triggered: true });
    }
  };

  const activateBlackHole = projectile => {
    const position = { ...projectile.body.getPosition() };
    engine.physics.destroyBody(projectile.body);
    blackHoles.push({ position, remainingMs: initialLevel.blackHole.durationSeconds * 1000, ageMs: 0 });
  };

  const updateSpecialProjectiles = milliseconds => {
    const next = [];
    for (const projectile of specialProjectiles) {
      if (!engine.physics.isCurrentBody(projectile.body)) continue;
      if (!projectile.triggered && touchingNonWall(projectile.body)) {
        if (projectile.type === 'split') activateSplit(projectile);
        else if (projectile.type === 'blackHole') activateBlackHole(projectile);
        continue;
      }
      next.push(projectile);
    }
    specialProjectiles = next;
    for (const blackHole of blackHoles) {
      blackHole.remainingMs -= milliseconds;
      blackHole.ageMs += milliseconds;
      for (const body of engine.physics.getCastleBodies()) {
        if (!engine.physics.isCurrentBody(body) || !body.isDynamic?.()) continue;
        const position = body.getPosition();
        const distance = Math.hypot(blackHole.position.x - position.x, blackHole.position.y - position.y);
        if (distance <= initialLevel.blackHole.consumeRadius) engine.physics.destroyBody(body);
        else if (distance <= initialLevel.blackHole.attractionRadius) body.applyForceToCenter(blackHoleForce(position, blackHole.position, initialLevel.blackHole), true);
      }
    }
    blackHoles = blackHoles.filter(effect => effect.remainingMs > 0);
    specialEffects = specialEffects.map(effect => ({ ...effect, remainingMs: effect.remainingMs - milliseconds })).filter(effect => effect.remainingMs > 0);
  };

  const specialActive = () => specialProjectiles.some(projectile => (
    isSpecialProjectileActive(projectile, body => engine.physics.isCurrentBody(body))
  )) || blackHoles.length > 0;
  const specialAvailable = () => specialAmmo.split > 0 || specialAmmo.blackHole > 0;

  const snapshot = () => {
    active();
    const original = engine.getSnapshot();
    frozenController.afterStep();
    flushFrozenRemovals();
    const frozenBodies = frozenController.snapshot();
    const worldBodies = new Set();
    for (let body = engine.physics.getWorld().getBodyList(); body; body = body.getNext()) {
      worldBodies.add(body);
    }
    const currentTargetIds = new Set(engine.physics.getCastleBodies()
      .filter(body => worldBodies.has(body))
      .map(body => body.getUserData?.()?.id)
      .filter(Boolean));
    const bodies = renderingBodies(engine.physics, originalObjects).map(body => bodySnapshot(body, originalObjects));
    const objectives = reconcileFrozenObjectives(original, frozenBodies, currentTargetIds);
    return freeze({
      ...original,
      ...objectives,
      selectedProjectile,
      selectedMeteor: selectedProjectile,
      splitAmmo: specialAmmo.split,
      blackHoleAmmo: specialAmmo.blackHole,
      projectiles: bodies.filter((body) => body.meteorType || body.kind === 'meteor'),
      bodies,
      damageEvents: original.damageEvents.map(eventSnapshot),
      explosionEvents: original.explosionEvents.map(eventSnapshot),
      frozenBodies,
      blackHoles: clone(blackHoles),
      blackHoleConfig: clone(initialLevel.blackHole),
      specialEffects: clone(specialEffects),
      ...((specialActive() && objectives.phase === 'won') || (objectives.phase === 'lost' && specialAvailable()) ? { phase: 'playing' } : {}),
    });
  };

  return {
    selectProjectile(type) {
      active();
      if (!['normal', 'explosive', 'split', 'blackHole'].includes(type)) return false;
      if (type === 'normal' || type === 'explosive') engine.selectMeteor(type);
      selectedProjectile = type;
      return true;
    },
    aimAt(point) {
      active();
      const aim = originalAimAtTarget(point, engine.launcher.totalArcDegrees);
      if (!aim) return false;
      engine.launcherAngleDegrees = aim.angleDegrees;
      return true;
    },
    aim(deltaDegrees) {
      active();
      return engine.aimByDegrees(deltaDegrees);
    },
    fireAt(point) {
      active();
      const aim = originalAimAtTarget(point, engine.launcher.totalArcDegrees);
      if (!aim) return 'out-of-arc';
      engine.launcherAngleDegrees = aim.angleDegrees;
      return this.fire();
    },
    fire() {
      active();
      if (selectedProjectile === 'normal' || selectedProjectile === 'explosive') return engine.fireAtCurrentAngle();
      if (specialAmmo[selectedProjectile] <= 0 || engine.getSnapshot().phase === 'won') return 'blocked';
      const radians = engine.launcherAngleDegrees * Math.PI / 180;
      const direction = { x: Math.sin(radians), y: Math.cos(radians) };
      const body = spawnConfiguredProjectile(direction, selectedProjectile, initialLevel[selectedProjectile]);
      specialProjectiles.push({ body, type: selectedProjectile, triggered: false });
      specialAmmo[selectedProjectile] -= 1;
      return 'fired';
    },
    step(milliseconds) {
      active();
      engine.update(milliseconds);
      updateSpecialProjectiles(milliseconds);
      const originalStep = engine.getSnapshot();
      processFrozenDamageEvents({
        stateMachine: frozenStateMachine,
        groups: frozenGroups,
        damageEvents: originalStep.damageEvents,
        explosionEvents: originalStep.explosionEvents,
        eventToken: `step-${++frozenEventSequence}`,
      });
      frozenController.afterStep();
      flushFrozenRemovals();
      return snapshot();
    },
    snapshot,
    reset() {
      active();
      frozenController.dispose();
      engine.reset(clone(initialLevel));
      frozenStateMachine.reset();
      frozenController = createFrozenCompoundController({
        world: engine.physics.getWorld(),
        groups: frozenGroups,
        originalObjects,
        profile: frozenProfile,
        stateMachine: frozenStateMachine,
      });
      frozenEventSequence = 0;
      specialAmmo = { ...specialAmmoStart };
      selectedProjectile = 'normal';
      specialProjectiles = [];
      blackHoles = [];
      specialEffects = [];
      return snapshot();
    },
    dispose() {
      if (disposed) return;
      frozenController.dispose();
      engine.damage?.stop?.();
      engine.explosions?.stop?.();
      disposed = true;
      engine = null;
    },
  };
}
