import { DEFAULT_FROZEN_BODY_PROFILE } from './global-config-document.js';

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export const RUNTIME_PHYSICS_FIELDS = Object.freeze([
  { group: 'environment', path: 'runtime.environment.baseWidth', label: '地基宽度', min: 0, exclusiveMin: true },
  { group: 'environment', path: 'runtime.environment.baseFriction', label: '地基摩擦', min: 0, max: 1 },
  { group: 'environment', path: 'runtime.environment.baseRestitution', label: '地基弹性', min: 0, max: 1 },
  { group: 'environment', path: 'runtime.environment.hillFriction', label: '山体摩擦', min: 0, max: 1 },
  { group: 'environment', path: 'runtime.environment.hillRestitution', label: '山体弹性', min: 0, max: 1 },
  { group: 'launcher', path: 'runtime.launcher.totalArcDegrees', label: '炮台射界', min: 0, max: 360, exclusiveMin: true },
  { group: 'normalProjectile', path: 'runtime.global.gravity', label: '重力', min: 0 },
  { group: 'normalProjectile', path: 'runtime.global.settleLinearSpeed', label: '线速度结算阈值', min: 0 },
  { group: 'normalProjectile', path: 'runtime.global.settleAngularSpeed', label: '角速度结算阈值', min: 0 },
  { group: 'normalProjectile', path: 'runtime.global.settleDurationMs', label: '结算等待毫秒', min: 0 },
  { group: 'normalProjectile', path: 'runtime.meteor.radius', label: '普通弹半径', min: 0, exclusiveMin: true },
  { group: 'normalProjectile', path: 'runtime.meteor.mass', label: '普通弹质量', min: 0, exclusiveMin: true },
  { group: 'normalProjectile', path: 'runtime.meteor.initialDownSpeed', label: '普通弹初速度', min: 0 },
  { group: 'normalProjectile', path: 'runtime.meteor.friction', label: '普通弹摩擦', min: 0, max: 1 },
  { group: 'normalProjectile', path: 'runtime.meteor.restitution', label: '普通弹弹性', min: 0, max: 1 },
  { group: 'explosiveProjectile', path: 'runtime.explosive.meteorRadius', label: '爆炸弹半径', min: 0, exclusiveMin: true },
  { group: 'explosiveProjectile', path: 'runtime.explosive.mass', label: '爆炸弹质量', min: 0, exclusiveMin: true },
  { group: 'explosiveProjectile', path: 'runtime.explosive.initialDownSpeed', label: '爆炸弹初速度', min: 0 },
  { group: 'explosiveProjectile', path: 'runtime.explosive.friction', label: '爆炸弹摩擦', min: 0, max: 1 },
  { group: 'explosiveProjectile', path: 'runtime.explosive.restitution', label: '爆炸弹弹性', min: 0, max: 1 },
  { group: 'explosionPropagation', path: 'runtime.explosive.radius', label: '爆炸半径', min: 0, exclusiveMin: true },
  { group: 'explosionPropagation', path: 'runtime.explosive.maxImpulse', label: '最大冲量', min: 0 },
  { group: 'explosionPropagation', path: 'runtime.explosive.damage', label: '爆炸伤害', min: 0 },
  { group: 'explosionPropagation', path: 'runtime.explosive.falloffExponent', label: '衰减指数', min: 0, exclusiveMin: true },
  { group: 'explosionPropagation', path: 'runtime.explosive.propagationSpeed', label: '传播速度', min: 0, exclusiveMin: true },
  { group: 'splitProjectile', path: 'runtime.split.radius', label: '主弹半径', min: 0, exclusiveMin: true },
  { group: 'splitProjectile', path: 'runtime.split.mass', label: '主弹质量', min: 0, exclusiveMin: true },
  { group: 'splitProjectile', path: 'runtime.split.initialDownSpeed', label: '主弹速度', min: 0, exclusiveMin: true },
  { group: 'splitProjectile', path: 'runtime.split.friction', label: '主弹摩擦', min: 0, max: 1 },
  { group: 'splitProjectile', path: 'runtime.split.restitution', label: '主弹弹性', min: 0, max: 1 },
  { group: 'splitProjectile', path: 'runtime.split.childRadius', label: '子弹半径', min: 0, exclusiveMin: true },
  { group: 'splitProjectile', path: 'runtime.split.childMass', label: '子弹质量', min: 0, exclusiveMin: true },
  { group: 'splitProjectile', path: 'runtime.split.childSpeed', label: '子弹速度', min: 0, exclusiveMin: true },
  { group: 'splitProjectile', path: 'runtime.split.splitCount', label: '分裂数量', min: 3, max: 3, integer: true },
  { group: 'splitProjectile', path: 'runtime.split.splitAngleDegrees', label: '分裂角度', min: 0, exclusiveMin: true },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.radius', label: '主弹半径', min: 0, exclusiveMin: true },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.mass', label: '主弹质量', min: 0, exclusiveMin: true },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.initialDownSpeed', label: '主弹速度', min: 0, exclusiveMin: true },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.friction', label: '主弹摩擦', min: 0, max: 1 },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.restitution', label: '主弹弹性', min: 0, max: 1 },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.attractionRadius', label: '吸引半径', min: 0, exclusiveMin: true },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.consumeRadius', label: '吞噬半径', min: 0, exclusiveMin: true },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.durationSeconds', label: '持续时间', min: 0, exclusiveMin: true },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.attractionForce', label: '径向吸力', min: 0, exclusiveMin: true },
  { group: 'blackHoleProjectile', path: 'runtime.blackHole.orbitForce', label: '旋转力', min: 0, exclusiveMin: true },
  { group: 'frozenBody', path: 'runtime.frozenBody.friction', label: '冰冻体摩擦', min: 0, max: 1 },
  { group: 'frozenBody', path: 'runtime.frozenBody.restitution', label: '冰冻体弹性', min: 0, max: 1 },
  { group: 'frozenBody', path: 'runtime.frozenBody.hitSpeedThreshold', label: '冰冻体受击速度阈值', min: 0 },
]);

const RUNTIME_FIELD_RULES = new Map(RUNTIME_PHYSICS_FIELDS.map(field => [field.path, field]));

function pathValue(root, path) {
  return path.split('.').reduce((value, part) => value?.[part], root);
}

function validateRuntimeValue(path, value) {
  const rule = RUNTIME_FIELD_RULES.get(path);
  if (!rule) return '未知全局配置字段';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '必须是有限数字';
  if (rule.integer && !Number.isInteger(value)) return '必须是整数';
  if (rule.exclusiveMin ? value <= rule.min : value < rule.min) return rule.exclusiveMin ? `必须大于 ${rule.min}` : `不能小于 ${rule.min}`;
  if (rule.max !== undefined && value > rule.max) return `不能大于 ${rule.max}`;
  return null;
}

export function validateProjectConfig(config) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  for (const path of ['canvas.width', 'canvas.height', 'world.width', 'world.height']) {
    const value = pathValue(config, path);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) add(path, '必须是正数');
  }
  for (const field of RUNTIME_PHYSICS_FIELDS) {
    const message = validateRuntimeValue(field.path, pathValue(config, field.path));
    if (message) add(field.path, message);
  }
  for (const path of ['runtime.global.initialAmmo', 'runtime.global.explosiveAmmo']) {
    const value = pathValue(config, path);
    if (!Number.isInteger(value) || value < 0) add(path, '必须是非负整数');
  }
  if (config.runtime?.blackHole?.consumeRadius > config.runtime?.blackHole?.attractionRadius) {
    add('runtime.blackHole.consumeRadius', '不得大于吸引半径');
  }
  return { ok: errors.length === 0, errors };
}

export function patchProjectConfig(config, path, value) {
  const message = RUNTIME_FIELD_RULES.has(path) ? validateRuntimeValue(path, value) : null;
  if (message) return { ok: false, error: { code: 'CONFIG_INVALID', path, message } };
  const next = clone(config);
  if (!setKnownPath(next, path, value)) return { ok: false, error: { code: 'CONFIG_INVALID', path, message: '未知配置字段' } };
  const validation = validateProjectConfig(next);
  if (!validation.ok) return { ok: false, error: { code: 'CONFIG_INVALID', ...validation.errors[0], errors: validation.errors } };
  return { ok: true, data: next };
}

export function assertProjectConfig(config) {
  const result = validateProjectConfig(config);
  if (result.ok) return config;
  const first = result.errors[0];
  throw Object.assign(new Error(`${first.path} ${first.message}`), { code: 'CONFIG_INVALID', details: { ...first, errors: result.errors } });
}

function setKnownPath(root, path, value) {
  const parts = path.split('.');
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || !own(cursor, part)) return false;
    cursor = cursor[part];
  }
  const last = parts.at(-1);
  if (!cursor || typeof cursor !== 'object' || !own(cursor, last)) return false;
  cursor[last] = value;
  return true;
}

function validate(path, value) {
  if (RUNTIME_FIELD_RULES.has(path)) return validateRuntimeValue(path, value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return '必须是有限数字';
  if (value < 0) return '不能小于 0';
  if (/(?:friction|restitution)$/.test(path) && value > 1) return '必须在 0 到 1 之间';
  return null;
}

export function createGlobalPhysicsStore({ defaults, assets, persistence = null } = {}) {
  if (!defaults || !assets) throw new TypeError('Global physics store requires defaults and assets');
  let state = { revision: 0, config: clone(defaults), assets: clone(assets) };
  const subscribers = new Set();
  const snapshot = () => freeze(clone(state));

  return Object.freeze({
    getSnapshot: snapshot,
    runtimeConfig() {
      const config = clone(state.config.runtime ?? state.config);
      config.objectProfiles = {
        materials: clone(state.assets.materials ?? {}),
        explosiveBarrel: clone(state.assets.specialObjects?.['explosive-barrel'] ?? state.assets.explosiveBarrel ?? {}),
        frozenBody: clone(state.config.runtime?.frozenBody ?? DEFAULT_FROZEN_BODY_PROFILE),
      };
      return freeze(config);
    },
    applyPatch(path, value) {
      const message = validate(path, value);
      if (message) return { ok: false, error: { code: 'INVALID_GLOBAL_PHYSICS', path, message } };
      const next = clone(state);
      if (!setKnownPath(next, path, value)) {
        return { ok: false, error: { code: 'INVALID_GLOBAL_PHYSICS', path, message: '未知全局配置字段' } };
      }
      next.revision += 1;
      state = next;
      persistence?.save?.({ config: clone(state.config), assets: clone(state.assets) });
      const current = snapshot();
      subscribers.forEach((subscriber) => subscriber(current));
      return { ok: true, data: current };
    },
    subscribe(subscriber) {
      if (typeof subscriber !== 'function') throw new TypeError('subscriber must be a function');
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  });
}
