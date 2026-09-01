const clone = value => structuredClone(value);

export const ASSET_KINDS = Object.freeze(['materials', 'shapes', 'specialObjects']);
const ALLOWED_KINDS = new Set(ASSET_KINDS);
const MATERIAL_NUMBER_RULES = Object.freeze({
  mass: value => Number.isFinite(value) && value > 0,
  friction: value => Number.isFinite(value) && value >= 0 && value <= 1,
  restitution: value => Number.isFinite(value) && value >= 0 && value <= 1,
  maxHp: value => Number.isFinite(value) && value > 0,
  hitSpeedThreshold: value => Number.isFinite(value) && value >= 0,
});
const SPECIAL_NUMBER_RULES = Object.freeze({
  mass: value => Number.isFinite(value) && value > 0,
  friction: value => Number.isFinite(value) && value >= 0 && value <= 1,
  restitution: value => Number.isFinite(value) && value >= 0 && value <= 1,
  maxHp: value => Number.isFinite(value) && value > 0,
  hitSpeedThreshold: value => Number.isFinite(value) && value >= 0,
});
const SHAPE_KINDS = new Set(['box', 'circle', 'polygon']);
const COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value) {
  return typeof value === 'string' && COLOR_PATTERN.test(value);
}

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function ownedAssets(source = {}) {
  return Object.fromEntries(ASSET_KINDS.map(kind => [kind, clone(source[kind] ?? {})]));
}

const validNumber = (value, minimum, inclusive = false) => typeof value === 'number'
  && Number.isFinite(value)
  && (inclusive ? value >= minimum : value > minimum);
const EXPLOSION_NUMBER_RULES = Object.freeze({
  radius: value => validNumber(value, 0),
  maxImpulse: value => validNumber(value, 0),
  damage: value => validNumber(value, 0, true),
  falloffExponent: value => validNumber(value, 0),
  propagationSpeed: value => validNumber(value, 0),
});

function validatePolygon(vertices, details) {
  if (!Array.isArray(vertices) || vertices.length < 3) throw failure('ASSET_INVALID', 'polygon vertices 无效', { ...details, field: 'shape.vertices' });
  let direction = 0;
  let area = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    const c = vertices[(index + 2) % vertices.length];
    if (![a, b, c].every(point => point && typeof point === 'object' && validNumber(point.x, -Infinity, true) && validNumber(point.y, -Infinity, true))) {
      throw failure('ASSET_INVALID', 'polygon vertices 无效', { ...details, field: 'shape.vertices' });
    }
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) throw failure('ASSET_INVALID', 'polygon 顶点不能重复', { ...details, field: 'shape.vertices' });
    area += a.x * b.y - b.x * a.y;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (direction && Math.sign(cross) !== direction) throw failure('ASSET_INVALID', 'polygon 必须为凸多边形', { ...details, field: 'shape.vertices' });
    direction = Math.sign(cross);
  }
  if (!direction || Math.abs(area) < 1e-9) throw failure('ASSET_INVALID', 'polygon vertices 无效', { ...details, field: 'shape.vertices' });
}

function validateShape(shape, details) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape) || !SHAPE_KINDS.has(shape.kind)) {
    throw failure('ASSET_INVALID', 'shape kind 无效', { ...details, field: 'shape.kind' });
  }
  if (shape.kind === 'box') {
    if (!validNumber(shape.width, 0)) throw failure('ASSET_INVALID', 'box width 无效', { ...details, field: 'shape.width' });
    if (!validNumber(shape.height, 0)) throw failure('ASSET_INVALID', 'box height 无效', { ...details, field: 'shape.height' });
  } else if (shape.kind === 'circle') {
    if (!validNumber(shape.radius, 0)) throw failure('ASSET_INVALID', 'circle radius 无效', { ...details, field: 'shape.radius' });
  } else validatePolygon(shape.vertices, details);
  if (shape.cornerRadius !== undefined && !validNumber(shape.cornerRadius, 0, true)) {
    throw failure('ASSET_INVALID', 'cornerRadius 无效', { ...details, field: 'shape.cornerRadius' });
  }
}

function validateColor(value, details, required = false) {
  if (value === undefined && !required) return;
  if (!isHexColor(value)) {
    throw failure('ASSET_INVALID', 'color 必须为十六进制颜色', { ...details, field: 'color', value });
  }
}

function validateImagePath(value, details) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.startsWith('level/asset/') || value.includes('\\') || value.includes('?') || value.includes('#')) {
    throw failure('ASSET_INVALID', 'image 路径无效', { ...details, field: 'image', value });
  }
  const segments = value.split('/');
  if (segments.length < 3 || segments.some((segment, index) => index > 1 && (!segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9._-]+$/.test(segment)))) {
    throw failure('ASSET_INVALID', 'image 路径无效', { ...details, field: 'image', value });
  }
}

function validateExplosion(explosion, details) {
  if (!explosion || typeof explosion !== 'object' || Array.isArray(explosion)) {
    throw failure('ASSET_INVALID', 'explosion 无效', { ...details, field: 'explosion' });
  }
  for (const [field, accepts] of Object.entries(EXPLOSION_NUMBER_RULES)) {
    const value = explosion[field];
    if (typeof value !== 'number' || !accepts(value)) {
      throw failure('ASSET_INVALID', `explosion.${field} 无效`, { ...details, field: `explosion.${field}`, value });
    }
  }
  for (const [field, value] of Object.entries(explosion)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw failure('ASSET_INVALID', `explosion.${field} 无效`, { ...details, field: `explosion.${field}`, value });
    }
  }
}

export function validateAsset(kind, asset) {
  if (!ALLOWED_KINDS.has(kind) || !asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw failure('ASSET_INVALID', '资源类型无效', { kind });
  }
  if (typeof asset.id !== 'string' || !asset.id.trim()) {
    throw failure('ASSET_INVALID', '资源 ID 不能为空', { kind, id: asset.id });
  }
  if (typeof asset.name !== 'string' || !asset.name.trim()) {
    throw failure('ASSET_INVALID', '资源名称不能为空', { kind, id: asset.id, field: 'name' });
  }
  validateImagePath(asset.image, { kind, id: asset.id });
  if (kind === 'materials') {
    validateColor(asset.color, { kind, id: asset.id }, true);
    for (const [field, accepts] of Object.entries(MATERIAL_NUMBER_RULES)) {
      const value = asset[field];
      if (typeof value !== 'number' || !accepts(value)) throw failure('ASSET_INVALID', `${field} 数值无效`, { kind, id: asset.id, field, value });
    }
    if (typeof asset.destructible !== 'boolean') {
      throw failure('ASSET_INVALID', 'destructible 必须是布尔值', { kind, id: asset.id, field: 'destructible', value: asset.destructible });
    }
  }
  if (kind === 'shapes') validateShape(asset.shape, { kind, id: asset.id });
  if (kind === 'specialObjects') {
    validateColor(asset.color, { kind, id: asset.id }, true);
    for (const field of ['specialType', 'materialId', 'shapePresetId']) {
      if (typeof asset[field] !== 'string' || !asset[field]) throw failure('ASSET_INVALID', `${field} 无效`, { kind, id: asset.id, field });
    }
    for (const [field, accepts] of Object.entries(SPECIAL_NUMBER_RULES)) {
      if (asset[field] !== undefined && (typeof asset[field] !== 'number' || !accepts(asset[field]))) {
        throw failure('ASSET_INVALID', `${field} 数值无效`, { kind, id: asset.id, field, value: asset[field] });
      }
    }
    if (asset.destructible !== undefined && typeof asset.destructible !== 'boolean') {
      throw failure('ASSET_INVALID', 'destructible 必须是布尔值', { kind, id: asset.id, field: 'destructible' });
    }
    if (asset.fixedBolt !== undefined && typeof asset.fixedBolt !== 'boolean') throw failure('ASSET_INVALID', 'fixedBolt 必须是布尔值', { kind, id: asset.id, field: 'fixedBolt' });
    if (asset.explosion !== undefined) validateExplosion(asset.explosion, { kind, id: asset.id });
  }
  return asset;
}

export function validateAssetGraph(assets) {
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) throw failure('ASSET_INVALID', 'asset graph 无效', { field: 'assets' });
  for (const field of Object.keys(assets)) {
    if (!ALLOWED_KINDS.has(field)) throw failure('ASSET_INVALID', `不支持资源分类：${field}`, { field });
  }
  const ids = new Set();
  for (const kind of ASSET_KINDS) {
    const group = assets[kind];
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw failure('ASSET_INVALID', `${kind} 无效`, { kind, field: kind });
    for (const [id, asset] of Object.entries(group)) {
      validateAsset(kind, asset);
      if (asset.id !== id) throw failure('ASSET_INVALID', `资源键与 ID 不一致：${id}`, { kind, id, field: 'id' });
      if (ids.has(id)) throw failure('ASSET_INVALID', `资源 ID 重复：${id}`, { kind, id, field: 'id' });
      ids.add(id);
    }
  }
  for (const [id, special] of Object.entries(assets.specialObjects)) {
    if (!assets.materials[special.materialId]) throw failure('ASSET_INVALID', `材料依赖不存在：${special.materialId}`, { kind: 'specialObjects', id, field: 'materialId' });
    if (!assets.shapes[special.shapePresetId]) throw failure('ASSET_INVALID', `形状依赖不存在：${special.shapePresetId}`, { kind: 'specialObjects', id, field: 'shapePresetId' });
  }
  return { ok: true, errors: [] };
}

export function assetEntries(assets = {}) {
  const labels = { materials: '材料', shapes: '形状', specialObjects: '特殊物件' };
  return ASSET_KINDS.flatMap(kind => Object.entries(assets[kind] ?? {}).map(([id, asset]) => ({
    ...clone(asset),
    id,
    kind,
    group: labels[kind],
    catalogType: kind === 'materials' ? 'material' : kind === 'shapes' ? 'shape' : 'special',
    type: kind === 'materials' ? 'material' : kind === 'shapes' ? 'shape' : 'special',
    symbol: asset.symbol ?? (kind === 'materials' ? '材' : kind === 'specialObjects' ? '爆' : asset.hollow === true ? '□' : asset.shape?.kind === 'circle' ? '●' : asset.shape?.kind === 'polygon' ? '▲' : '■'),
  })));
}

export function libraryAssetEntries(assets = {}) {
  return assetEntries(assets).filter(asset => asset.libraryVisible !== false);
}

export function scanAssetReferences(levels = [], assetId) {
  const referenceFields = ['materialId', 'shapePresetId', 'specialType'];
  const references = [];
  for (const level of levels) {
    for (const object of level.castle ?? []) {
      for (const field of referenceFields) {
        if (object?.[field] !== assetId) continue;
        references.push({
          levelPath: level.filePath ?? level.fileName ?? `level-${level.levelNumber ?? level.id}.json`,
          levelId: level.levelNumber ?? level.id,
          objectId: object.id,
          field,
        });
      }
    }
  }
  return references;
}

export function scanAssetDefinitionReferences(assets = {}, assetId) {
  const references = [];
  for (const [id, resource] of Object.entries(assets.specialObjects ?? {})) {
    for (const field of ['materialId', 'shapePresetId']) {
      if (resource?.[field] !== assetId) continue;
      references.push({ levelPath: '全局配置.json', levelId: undefined, objectId: id, field });
    }
  }
  return references;
}

function uniqueObjectId(level, prefix) {
  const used = new Set((level?.castle ?? []).map(object => object.id));
  let suffix = 1;
  while (used.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

function objectGeometry(assets, shapePresetId, materialId) {
  const shapeAsset = assets.shapes?.[shapePresetId];
  const material = assets.materials?.[materialId];
  if (!shapeAsset) throw failure('ASSET_INVALID', `形状资源不存在：${shapePresetId}`, { kind: 'shapes', id: shapePresetId });
  if (!material) throw failure('ASSET_INVALID', `材料资源不存在：${materialId}`, { kind: 'materials', id: materialId });
  return {
    shapePresetId,
    shape: clone(shapeAsset.shape),
    materialId,
  };
}

function availableId(group, preferred) {
  return group?.[preferred] ? preferred : Object.keys(group ?? {})[0];
}

export function createAssetObject({ assets, kind, id, level = { castle: [] }, point = { x: 0, y: 0 } }) {
  if (!ALLOWED_KINDS.has(kind)) throw failure('ASSET_INVALID', `资源类型无效：${kind}`, { kind, id });
  const resource = assets?.[kind]?.[id];
  if (!resource) throw failure('ASSET_INVALID', `资源不存在：${id}`, { kind, id });
  const base = {
    id: uniqueObjectId(level, id),
    name: resource.name ?? id,
    x: Number(point.x),
    y: Number(point.y),
    angle: 0,
  };

  if (kind === 'materials') {
    return { ...base, ...objectGeometry(assets, availableId(assets.shapes, 'square'), id) };
  }
  if (kind === 'shapes') {
    return { ...base, ...objectGeometry(assets, id, availableId(assets.materials, 'wood')) };
  }

  const shapePresetId = resource.shapePresetId ?? availableId(assets.shapes, 'square');
  const materialId = resource.materialId ?? availableId(assets.materials, 'wood');
  return {
    ...base,
    ...objectGeometry(assets, shapePresetId, materialId),
    specialType: resource.specialType ?? id,
  };
}

export function createAssetStore(initialAssets, { persistence = null } = {}) {
  let initialValidation = { ok: true, errors: [] };
  try { validateAssetGraph(initialAssets); } catch (error) { initialValidation = { ok: false, errors: [{ code: error.code, message: error.message, ...clone(error.details) }] }; }
  let state = {
    assets: ownedAssets(initialAssets),
    selection: null,
    dirty: false,
    validation: initialValidation,
  };
  const listeners = new Set();
  const stagedImages = new Map();
  const publish = next => {
    state = next;
    const snapshot = clone(state);
    for (const listener of listeners) listener(snapshot);
  };
  const invalid = error => {
    publish({ ...state, validation: { ok: false, errors: [{ code: error.code, message: error.message, ...clone(error.details) }] } });
    throw error;
  };
  const validState = updates => ({ ...state, ...updates, validation: { ok: true, errors: [] } });

  return {
    get snapshot() { return clone(state); },
    get stagedImages() { return new Map(stagedImages); },
    select(kind, id) {
      if (id == null) {
        publish(validState({ selection: null }));
        return;
      }
      if (!ALLOWED_KINDS.has(kind) || !state.assets[kind]?.[id]) return invalid(failure('ASSET_INVALID', `资源不存在：${id}`, { kind, id }));
      publish(validState({ selection: { kind, id } }));
    },
    patchSelected(updates) {
      const selected = state.selection;
      if (!selected) return invalid(failure('ASSET_INVALID', '尚未选择资源'));
      const current = state.assets[selected.kind]?.[selected.id];
      const nextAsset = { ...current, ...clone(updates), id: selected.id };
      const nextAssets = { ...state.assets, [selected.kind]: { ...state.assets[selected.kind], [selected.id]: nextAsset } };
      try { validateAssetGraph(nextAssets); } catch (error) { return invalid(error); }
      publish(validState({
        assets: nextAssets,
        dirty: true,
      }));
    },
    add(kind, asset) {
      try { validateAsset(kind, asset); } catch (error) { return invalid(error); }
      if (state.assets[kind]?.[asset.id]) return invalid(failure('ASSET_DUPLICATE', `资源 ID 已存在：${asset.id}`, { kind, id: asset.id }));
      const nextAssets = { ...state.assets, [kind]: { ...state.assets[kind], [asset.id]: clone(asset) } };
      try { validateAssetGraph(nextAssets); } catch (error) { return invalid(error); }
      publish(validState({
        assets: nextAssets,
        selection: { kind, id: asset.id },
        dirty: true,
      }));
    },
    remove(kind, id, references = []) {
      if (references.length) {
        const locations = references.map(reference => `${reference.levelPath}#${reference.objectId}`).join('、');
        return invalid(failure('ASSET_REFERENCED', `资源仍被 ${references.length} 个物件引用：${locations}`, { kind, id, references: clone(references) }));
      }
      if (!ALLOWED_KINDS.has(kind) || !state.assets[kind]?.[id]) return invalid(failure('ASSET_INVALID', `资源不存在：${id}`, { kind, id }));
      const group = { ...state.assets[kind] };
      delete group[id];
      publish(validState({ assets: { ...state.assets, [kind]: group }, selection: null, dirty: true }));
    },
    stageImage(kind, id, { name, base64 }) {
      if (!state.assets[kind]?.[id]) return invalid(failure('ASSET_INVALID', `资源不存在：${id}`, { kind, id }));
      const safeName = String(name || 'image').replace(/[^a-zA-Z0-9._-]/g, '-');
      const path = `level/asset/${id}-${safeName}`;
      stagedImages.set(path, base64);
      this.select(kind, id);
      this.patchSelected({ image: path });
      return path;
    },
    markSaved() { publish(validState({ dirty: false })); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async save() { return persistence?.saveAssets?.(clone(state.assets), new Map(stagedImages)); },
  };
}
