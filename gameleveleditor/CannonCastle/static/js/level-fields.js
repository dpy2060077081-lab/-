const PLATFORM_TYPES = Object.freeze(['single-3', 'single-5', 'double-2', 'double-3']);
const DIFFICULTIES = Object.freeze(['normal', 'hard', 'super-hard']);

export const LEVEL_FIELD_DEFINITIONS = Object.freeze([
  { id: 'levelName', label: '名称', type: 'text', span: 2 },
  { id: 'levelNumber', label: '关卡编号', type: 'integer', min: 0 },
  { id: 'difficulty', label: '难度标记', type: 'select', options: DIFFICULTIES },
  { id: 'description', label: '关卡描述', type: 'textarea', span: 3 },
  { id: 'normalAmmo', label: '普通弹药', type: 'integer', min: 0 },
  { id: 'explosiveAmmo', label: '爆炸弹药', type: 'integer', min: 0 },
  { id: 'splitAmmo', label: '分裂弹药', type: 'integer', min: 0 },
  { id: 'blackHoleAmmo', label: '黑洞弹药', type: 'integer', min: 0 },
  { id: 'platformType', label: '平台类型', type: 'select', options: PLATFORM_TYPES },
]);

const CONTROLLED_KEYS = new Set([
  ...LEVEL_FIELD_DEFINITIONS.map(field => field.id),
  'castle',
  '__levelDocument',
  'fileName',
  'filePath',
  'workspaceId',
  'workspaceKind',
  'numberConflict',
]);

const clone = value => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

export function levelExtensionValues(level) {
  return Object.fromEntries(Object.entries(level || {})
    .filter(([key]) => !CONTROLLED_KEYS.has(key))
    .map(([key, value]) => [key, clone(value)]));
}

export function mergeLevelExtensionValues(level, extensions) {
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) {
    throw new TypeError('扩展字段必须是 JSON 对象');
  }
  for (const key of Object.keys(extensions)) {
    if (CONTROLLED_KEYS.has(key)) {
      throw new Error(`扩展字段不能覆盖 ${key}`);
    }
  }
  return clone(extensions);
}

export function parseLevelFieldValue(fieldId, rawValue) {
  const field = LEVEL_FIELD_DEFINITIONS.find(candidate => candidate.id === fieldId);
  if (!field) throw new Error(`未知关卡字段：${fieldId}`);
  if (field.type === 'integer') {
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < field.min) throw new Error(`${field.label}必须是非负整数`);
    return value;
  }
  const value = String(rawValue ?? '');
  if (field.type === 'select' && !field.options.includes(value)) throw new Error(`${field.label}不受支持`);
  return value;
}
