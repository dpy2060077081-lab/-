const clone = value => structuredClone(value);

export const DEFAULT_FROZEN_BODY_PROFILE = Object.freeze({
  friction: 0.1,
  restitution: 0.2,
  hitSpeedThreshold: 5,
});

export const DEFAULT_SPECIAL_PROJECTILES = Object.freeze({
  split: Object.freeze({ radius: 0.32, mass: 10, initialDownSpeed: 32, friction: 0.45, restitution: 0.5, childRadius: 0.22, childMass: 5, childSpeed: 32, splitCount: 3, splitAngleDegrees: 45 }),
  blackHole: Object.freeze({ radius: 0.32, mass: 10, initialDownSpeed: 20, friction: 0.45, restitution: 0.5, attractionRadius: 3.5, consumeRadius: 0.65, durationSeconds: 3, attractionForce: 12, orbitForce: 18 }),
});

function requireRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} 必须是对象`);
  }
  return value;
}

function requireFiniteNumberInRange(value, path, { max } = {}) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path} 必须是有限数字`);
  }
  if (value < 0 || (max !== undefined && value > max)) {
    throw new TypeError(`${path} 必须在 0 到 ${max ?? '正无穷'} 之间`);
  }
  return value;
}

function normalizeExplosiveBarrelLevel(document) {
  const output = clone(document);
  output.globalProjectiles ??= {};
  output.globalProjectiles.split = { ...clone(DEFAULT_SPECIAL_PROJECTILES.split), ...(output.globalProjectiles.split ?? {}) };
  output.globalProjectiles.blackHole = { ...clone(DEFAULT_SPECIAL_PROJECTILES.blackHole), ...(output.globalProjectiles.blackHole ?? {}) };
  const profiles = output?.globalObjectProfiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return output;
  if (!profiles.explosiveBarrel && profiles.specialObjects?.['explosive-barrel']) {
    profiles.explosiveBarrel = clone(profiles.specialObjects['explosive-barrel']);
  }
  delete profiles.specialObjects;
  return output;
}

function internalExplosiveBarrel(barrel) {
  return {
    id: 'explosive-barrel',
    name: '爆炸桶',
    specialType: 'explosive-barrel',
    shapePresetId: 'square',
    materialId: 'wood',
    ...clone(barrel),
  };
}

export function assertGlobalConfigDocument(document) {
  requireRecord(document, '全局配置');
  if (document.version !== 2) throw new TypeError('version 必须为 2');
  if (document.type !== 'global') throw new TypeError('type 必须为 global');
  requireRecord(document.canvas, 'canvas');
  requireRecord(document.world, 'world');
  requireRecord(document.runtime, 'runtime');
  requireRecord(document.runtime.global, 'runtime.global');
  requireRecord(document.globalEnvironment, 'globalEnvironment');
  const projectiles = {
    ...requireRecord(document.globalProjectiles, 'globalProjectiles'),
    split: document.globalProjectiles.split ?? DEFAULT_SPECIAL_PROJECTILES.split,
    blackHole: document.globalProjectiles.blackHole ?? DEFAULT_SPECIAL_PROJECTILES.blackHole,
  };
  requireRecord(projectiles.launcher, 'globalProjectiles.launcher');
  requireRecord(projectiles.meteor, 'globalProjectiles.meteor');
  requireRecord(projectiles.explosive, 'globalProjectiles.explosive');
  const split = requireRecord(projectiles.split, 'globalProjectiles.split');
  const blackHole = requireRecord(projectiles.blackHole, 'globalProjectiles.blackHole');
  for (const [key, value] of Object.entries(split)) requireFiniteNumberInRange(value, `globalProjectiles.split.${key}`);
  for (const [key, value] of Object.entries(blackHole)) requireFiniteNumberInRange(value, `globalProjectiles.blackHole.${key}`);
  for (const key of ['radius', 'mass', 'initialDownSpeed', 'childRadius', 'childMass', 'childSpeed', 'splitAngleDegrees']) {
    if (split[key] <= 0) throw new TypeError(`globalProjectiles.split.${key} 必须大于 0`);
  }
  for (const key of ['radius', 'mass', 'initialDownSpeed', 'attractionRadius', 'consumeRadius', 'durationSeconds', 'attractionForce', 'orbitForce']) {
    if (blackHole[key] <= 0) throw new TypeError(`globalProjectiles.blackHole.${key} 必须大于 0`);
  }
  for (const [group, values] of [['split', split], ['blackHole', blackHole]]) {
    for (const key of ['friction', 'restitution']) if (values[key] > 1) throw new TypeError(`globalProjectiles.${group}.${key} 必须在 0 到 1 之间`);
  }
  if (split.splitCount !== 3) throw new TypeError('globalProjectiles.split.splitCount 必须等于 3');
  if (blackHole.consumeRadius > blackHole.attractionRadius) throw new TypeError('globalProjectiles.blackHole.consumeRadius 不得大于 attractionRadius');
  const profiles = requireRecord(document.globalObjectProfiles, 'globalObjectProfiles');
  requireRecord(profiles.materials, 'globalObjectProfiles.materials');
  requireRecord(profiles.shapes, 'globalObjectProfiles.shapes');
  requireRecord(profiles.explosiveBarrel, 'globalObjectProfiles.explosiveBarrel');
  if (profiles.frozenBody !== undefined) {
    const frozenBody = requireRecord(profiles.frozenBody, 'globalObjectProfiles.frozenBody');
    requireFiniteNumberInRange(
      frozenBody.friction,
      'globalObjectProfiles.frozenBody.friction',
      { max: 1 },
    );
    requireFiniteNumberInRange(
      frozenBody.restitution,
      'globalObjectProfiles.frozenBody.restitution',
      { max: 1 },
    );
    requireFiniteNumberInRange(
      frozenBody.hitSpeedThreshold,
      'globalObjectProfiles.frozenBody.hitSpeedThreshold',
    );
  }
  return true;
}

export function decodeGlobalConfig(document) {
  const source = normalizeExplosiveBarrelLevel(document);
  assertGlobalConfigDocument(source);
  const config = {
    projectName: source.projectName,
    canvas: clone(source.canvas),
    world: clone(source.world),
    runtime: {
      global: clone(source.runtime.global),
      environment: clone(source.globalEnvironment),
      launcher: clone(source.globalProjectiles.launcher),
      meteor: clone(source.globalProjectiles.meteor),
      explosive: clone(source.globalProjectiles.explosive),
      split: clone(source.globalProjectiles.split ?? DEFAULT_SPECIAL_PROJECTILES.split),
      blackHole: clone(source.globalProjectiles.blackHole ?? DEFAULT_SPECIAL_PROJECTILES.blackHole),
      frozenBody: clone(source.globalObjectProfiles.frozenBody ?? DEFAULT_FROZEN_BODY_PROFILE),
    },
    scoreMode: source.scoreMode,
    resourceTheme: source.resourceTheme,
    unlockRule: source.unlockRule,
  };
  const assets = {
    materials: clone(source.globalObjectProfiles.materials),
    shapes: clone(source.globalObjectProfiles.shapes),
    specialObjects: { 'explosive-barrel': internalExplosiveBarrel(source.globalObjectProfiles.explosiveBarrel) },
  };
  return { document: source, config, assets };
}

export function createGlobalConfigDocument({ config, assets }) {
  return {
    version: 2,
    type: 'global',
    projectName: config.projectName,
    canvas: clone(config.canvas ?? {}),
    world: clone(config.world ?? {}),
    runtime: { global: clone(config.runtime?.global ?? {}) },
    globalEnvironment: clone(config.runtime?.environment ?? {}),
    globalProjectiles: {
      launcher: clone(config.runtime?.launcher ?? {}),
      meteor: clone(config.runtime?.meteor ?? {}),
      explosive: clone(config.runtime?.explosive ?? {}),
      split: clone(config.runtime?.split ?? DEFAULT_SPECIAL_PROJECTILES.split),
      blackHole: clone(config.runtime?.blackHole ?? DEFAULT_SPECIAL_PROJECTILES.blackHole),
    },
    globalObjectProfiles: {
      materials: clone(assets.materials ?? {}),
      shapes: clone(assets.shapes ?? {}),
      explosiveBarrel: clone(assets.specialObjects?.['explosive-barrel'] ?? {}),
      frozenBody: clone(config.runtime?.frozenBody ?? DEFAULT_FROZEN_BODY_PROFILE),
    },
    scoreMode: config.scoreMode,
    resourceTheme: config.resourceTheme,
    unlockRule: config.unlockRule,
  };
}

export function encodeGlobalConfig({ document, config, assets }) {
  assertGlobalConfigDocument(document);
  const output = clone(document);
  output.projectName = config.projectName;
  output.canvas = clone(config.canvas ?? {});
  output.world = clone(config.world ?? {});
  output.runtime = { global: clone(config.runtime?.global ?? {}) };
  output.globalEnvironment = clone(config.runtime?.environment ?? {});
  output.globalProjectiles = {
    launcher: clone(config.runtime?.launcher ?? {}),
    meteor: clone(config.runtime?.meteor ?? {}),
    explosive: clone(config.runtime?.explosive ?? {}),
    split: clone(config.runtime?.split ?? DEFAULT_SPECIAL_PROJECTILES.split),
    blackHole: clone(config.runtime?.blackHole ?? DEFAULT_SPECIAL_PROJECTILES.blackHole),
  };
  output.globalObjectProfiles = {
    materials: clone(assets.materials),
    shapes: clone(assets.shapes),
    explosiveBarrel: clone(assets.specialObjects?.['explosive-barrel'] ?? {}),
    frozenBody: clone(config.runtime?.frozenBody ?? DEFAULT_FROZEN_BODY_PROFILE),
  };
  output.scoreMode = config.scoreMode;
  output.resourceTheme = config.resourceTheme;
  output.unlockRule = config.unlockRule;
  assertGlobalConfigDocument(output);
  return output;
}
