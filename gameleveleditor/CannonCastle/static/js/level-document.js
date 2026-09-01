const clone = value => structuredClone(value);

const LEVEL_KEYS = new Set([
  'number', 'name', 'difficulty', 'description', 'normalAmmo', 'explosiveAmmo', 'splitAmmo', 'blackHoleAmmo', 'platformType', 'castle',
]);
const OBJECT_KEYS = [
  'id', 'name', 'x', 'y', 'angle', 'shapePresetId', 'materialId', 'specialType', 'fixedBolt',
];
const RUNTIME_OBJECT_KEYS = new Set([
  'shape', 'mass', 'friction', 'restitution', 'color', 'destructible', 'maxHp',
  'hitSpeedThreshold', 'explosion',
]);

const without = (value, omitted) => Object.fromEntries(
  Object.entries(value || {}).filter(([key]) => !omitted.has(key)),
);

export function isExportedLevelDocument(value) {
  return value?.version === 2 && value?.type === 'level' && value.level && typeof value.level === 'object';
}

export function decodeLevelDocument(document, assets = {}) {
  assets ??= {};
  if (!isExportedLevelDocument(document)) return clone(document);
  const source = document.level;
  const castle = (source.castle || []).map(object => {
    const shape = object.shape ?? assets.shapes?.[object.shapePresetId]?.shape;
    return { ...clone(object), ...(shape ? { shape: clone(shape) } : {}) };
  });
  return {
    ...clone(without(source, LEVEL_KEYS)),
    levelNumber: source.number,
    levelName: source.name,
    difficulty: source.difficulty,
    description: source.description,
    normalAmmo: source.normalAmmo,
    explosiveAmmo: source.explosiveAmmo,
    splitAmmo: source.splitAmmo,
    blackHoleAmmo: source.blackHoleAmmo,
    platformType: source.platformType,
    castle,
    __levelDocument: {
      version: document.version,
      type: document.type,
      levelId: document.levelId,
      rootExtensions: clone(without(document, new Set(['version', 'type', 'levelId', 'level']))),
    },
  };
}

function encodeObject(object) {
  const encoded = {};
  for (const key of OBJECT_KEYS) if (object[key] !== undefined) encoded[key] = clone(object[key]);
  for (const [key, value] of Object.entries(object)) {
    if (OBJECT_KEYS.includes(key) || RUNTIME_OBJECT_KEYS.has(key)) continue;
    encoded[key] = clone(value);
  }
  return encoded;
}

export function encodeLevelDocument(level) {
  const metadata = level?.__levelDocument;
  if (!metadata) return clone(level);
  const extensions = Object.fromEntries(Object.entries(level).filter(([key]) => ![
    'levelNumber', 'levelName', 'difficulty', 'description', 'normalAmmo', 'explosiveAmmo', 'splitAmmo', 'blackHoleAmmo',
    'platformType', 'castle', '__levelDocument', 'fileName', 'filePath', 'workspaceId',
    'workspaceKind', 'numberConflict',
  ].includes(key)));
  return {
    ...clone(metadata.rootExtensions || {}),
    version: metadata.version ?? 2,
    type: metadata.type ?? 'level',
    levelId: metadata.levelId,
    level: {
      ...clone(extensions),
      number: Number(level.levelNumber),
      name: level.levelName,
      difficulty: level.difficulty,
      description: level.description,
      normalAmmo: level.normalAmmo,
      explosiveAmmo: level.explosiveAmmo,
      ...(level.splitAmmo !== undefined ? { splitAmmo: level.splitAmmo } : {}),
      ...(level.blackHoleAmmo !== undefined ? { blackHoleAmmo: level.blackHoleAmmo } : {}),
      platformType: level.platformType,
      castle: (level.castle || []).map(encodeObject),
    },
  };
}

export function createExportedLevelMetadata(id) {
  return { version: 2, type: 'level', levelId: `level-${String(id).padStart(2, '0')}`, rootExtensions: {} };
}
