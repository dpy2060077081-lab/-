const clone = value => structuredClone(value);
const MATERIAL_FIELDS = Object.freeze([
  { path: 'name', type: 'text', label: '名称' },
  { path: 'color', type: 'color', label: '颜色' },
  { path: 'mass', type: 'number', label: '质量' },
  { path: 'friction', type: 'number', label: '摩擦' },
  { path: 'restitution', type: 'number', label: '弹性' },
  { path: 'destructible', type: 'boolean', label: '可破坏' },
  { path: 'maxHp', type: 'number', label: '耐久' },
  { path: 'hitSpeedThreshold', type: 'number', label: '碰撞速度阈值' },
]);
const SHAPE_FIELDS = Object.freeze([
  { path: 'name', type: 'text', label: '名称' },
  { path: 'shape', type: 'json', label: 'Geometry' },
]);
const SPECIAL_FIELDS = Object.freeze([
  { path: 'name', type: 'text', label: '名称' },
  { path: 'specialType', type: 'text', label: '特殊类型' },
  { path: 'materialId', type: 'material', label: '材料依赖' },
  { path: 'shapePresetId', type: 'shape', label: '形状依赖' },
  { path: 'color', type: 'color', label: '颜色' },
  { path: 'mass', type: 'number', label: '质量' },
  { path: 'friction', type: 'number', label: '摩擦' },
  { path: 'restitution', type: 'number', label: '弹性' },
  { path: 'destructible', type: 'boolean', label: '可破坏' },
  { path: 'maxHp', type: 'number', label: '耐久' },
  { path: 'hitSpeedThreshold', type: 'number', label: '碰撞速度阈值' },
  { path: 'fixedBolt', type: 'boolean', label: '固定连接' },
  { path: 'explosion', type: 'json', label: '特殊定义' },
]);
const OBJECT_FIELDS = Object.freeze([
  'x', 'y', 'angle', 'shape', 'materialId', 'mass', 'friction', 'restitution',
  'destructible', 'maxHp', 'hitSpeedThreshold', 'fixedBolt', 'specialType', 'explosion',
]);
const MULTI_FIELDS = new Set(['angle', 'materialId', 'mass', 'friction', 'restitution', 'destructible', 'maxHp', 'hitSpeedThreshold', 'fixedBolt', 'specialType']);

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assetCardCommand({ edit = false, key = null } = {}) {
  if (key !== null && !['Enter', ' '].includes(key)) return null;
  return edit ? 'edit' : 'add';
}
export function sharedObjectValues(objects = []) {
  if (!objects.length) return {};
  return Object.fromEntries(OBJECT_FIELDS
    .filter(field => MULTI_FIELDS.has(field) && objects.every(object => Object.hasOwn(object, field) && sameValue(object[field], objects[0][field])))
    .map(field => [field, clone(objects[0][field])]));
}

export function patchObjectFields(object, updates) {
  const next = { ...clone(object), ...clone(updates) };
  if (updates.shape && object.shape && (!updates.shape.kind || updates.shape.kind === object.shape.kind)) {
    next.shape = { ...clone(object.shape), ...clone(updates.shape) };
  }
  return next;
}

export function createItemInspector({ assetStore, editorStore, onAssetChange = () => {} }) {
  const selectedObjects = () => {
    const ids = new Set(editorStore.selectedObjectIds ?? []);
    return (editorStore.currentLevel?.castle ?? []).filter(object => ids.has(object.id));
  };
  const context = () => {
    const asset = assetStore.snapshot.selection;
    if (asset) return { type: 'asset', kind: asset.kind, id: asset.id };
    const ids = [...(editorStore.selectedObjectIds ?? [])];
    return ids.length ? { type: 'object', ids } : null;
  };

  return {
    context,
    selectAsset(kind, id) {
      editorStore.selectObjects([]);
      assetStore.select(kind, id);
    },
    selectObjects(ids) {
      assetStore.select(null, null);
      editorStore.selectObjects(ids);
    },
    fields() {
      const current = context();
      if (current?.type === 'asset') {
        const definitions = current.kind === 'materials' ? MATERIAL_FIELDS : current.kind === 'shapes' ? SHAPE_FIELDS : SPECIAL_FIELDS;
        const asset = assetStore.snapshot.assets[current.kind]?.[current.id] ?? {};
        return definitions.map(field => ({ ...clone(field), value: clone(asset[field.path]) }));
      }
      if (current?.type === 'object') {
        const objects = selectedObjects();
        const paths = objects.length > 1 ? [...MULTI_FIELDS] : OBJECT_FIELDS;
        return paths.map(path => ({ path, value: objects.length > 1 ? sharedObjectValues(objects)[path] : clone(objects[0]?.[path]) }));
      }
      return [];
    },
    values() {
      const current = context();
      if (current?.type === 'asset') return clone(assetStore.snapshot.assets[current.kind]?.[current.id] ?? {});
      const objects = selectedObjects();
      return objects.length > 1 ? sharedObjectValues(objects) : clone(objects[0] ?? {});
    },
    patch(updates) {
      const current = context();
      if (!current) throw Object.assign(new Error('尚未选择资源或物品'), { code: 'ITEM_CONTEXT_EMPTY' });
      if (current.type === 'asset') {
        assetStore.patchSelected(updates);
        onAssetChange(current);
        return;
      }
      editorStore.updateObjects(current.ids, object => patchObjectFields(object, updates));
    },
  };
}
