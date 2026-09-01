/**
 * Compatibility helpers for legacy Meteor Castle level JSON.
 *
 * These functions deliberately do not apply defaults or translate fields:
 * callers retain every value that was present in the imported document.
 */

const REQUIRED_OBJECT_SECTIONS = [
  'objectProfiles',
  'global',
  'meteor',
  'explosive',
  'launcher',
  'environment',
];

const CASTLE_OBJECT_FIELDS = [
  'id',
  'name',
  'x',
  'y',
  'angle',
  'shape',
  'mass',
  'friction',
  'restitution',
  'color',
  'materialId',
  'destructible',
  'maxHp',
  'hitSpeedThreshold',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function parsePath(path) {
  if (Array.isArray(path)) {
    if (path.length === 0 || path.some((segment) => typeof segment !== 'string' && typeof segment !== 'number')) {
      throw new TypeError('Patch paths must contain at least one string or number segment');
    }
    return path.map(String);
  }

  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('Patch paths must be non-empty strings or segment arrays');
  }

  const segments = path.match(/[^.[\]]+/g);
  if (!segments || segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`Invalid patch path: ${path}`);
  }
  return segments;
}

function isArrayIndex(segment) {
  return /^(0|[1-9]\d*)$/.test(segment);
}

function patchAtPath(value, segments, replacement) {
  const [segment, ...rest] = segments;
  const container = Array.isArray(value) ? value : isRecord(value) ? value : null;

  if (container === null || !hasOwn(container, segment)) {
    throw new RangeError(`Cannot patch missing path: ${segments.join('.')}`);
  }

  if (Array.isArray(container) && !isArrayIndex(segment)) {
    throw new TypeError(`Array path segment must be a non-negative integer: ${segment}`);
  }

  const copy = Array.isArray(container) ? container.slice() : { ...container };
  copy[segment] = rest.length === 0
    ? cloneValue(replacement)
    : patchAtPath(container[segment], rest, replacement);
  return copy;
}

/** Returns an independent copy of a level without applying defaults. */
export function cloneLevel(value) {
  return cloneValue(value);
}

/**
 * Applies a map of path-to-value edits immutably. Existing fields only are
 * patchable, which prevents a typo from silently producing a new schema.
 */
export function patchLevel(level, updates) {
  if (!isRecord(level)) throw new TypeError('A level must be an object');
  if (!isRecord(updates)) throw new TypeError('Updates must be an object');

  return Object.entries(updates).reduce(
    (draft, [path, value]) => patchAtPath(draft, parsePath(path), value),
    level,
  );
}

/** Serializes as JSON without field renaming, unit conversion, or defaults. */
export function serializeLevel(level) {
  return JSON.stringify(level);
}

/**
 * Checks only the level's structural contract. It never mutates, fills in, or
 * strips data, including unknown extension fields.
 */
export function validateLevelShape(level) {
  const errors = [];
  const error = (path, message) => errors.push({ path, message });

  if (!isRecord(level)) {
    error('', 'Level must be an object');
    return { valid: false, errors };
  }

  if (typeof level.difficulty !== 'string') error('difficulty', 'Difficulty must be a string');
  for (const section of REQUIRED_OBJECT_SECTIONS) {
    if (!isRecord(level[section])) error(section, `${section} must be an object`);
  }

  if (!Array.isArray(level.castle)) {
    error('castle', 'castle must be an array');
  } else {
    level.castle.forEach((castleObject, index) => {
      const path = `castle.${index}`;
      if (!isRecord(castleObject)) {
        error(path, 'Castle entries must be objects');
        return;
      }

      for (const field of CASTLE_OBJECT_FIELDS) {
        if (!hasOwn(castleObject, field)) error(`${path}.${field}`, `${field} is required`);
      }

      if (typeof castleObject.id !== 'string') error(`${path}.id`, 'id must be a string');
      if (typeof castleObject.name !== 'string') error(`${path}.name`, 'name must be a string');
      for (const field of ['x', 'y', 'angle', 'mass', 'friction', 'restitution', 'maxHp', 'hitSpeedThreshold']) {
        if (!Number.isFinite(castleObject[field])) error(`${path}.${field}`, `${field} must be finite`);
      }
      if (typeof castleObject.color !== 'string') error(`${path}.color`, 'color must be a string');
      if (typeof castleObject.materialId !== 'string') error(`${path}.materialId`, 'materialId must be a string');
      if (typeof castleObject.destructible !== 'boolean') error(`${path}.destructible`, 'destructible must be a boolean');
      if (!isRecord(castleObject.shape) || typeof castleObject.shape.kind !== 'string') {
        error(`${path}.shape`, 'shape must be an object with a kind');
      } else if (castleObject.shape.kind === 'box') {
        for (const field of ['width', 'height']) {
          if (!Number.isFinite(castleObject.shape[field]) || castleObject.shape[field] <= 0) {
            error(`${path}.shape.${field}`, `${field} must be finite and positive`);
          }
        }
      } else if (castleObject.shape.kind === 'circle') {
        if (!Number.isFinite(castleObject.shape.radius) || castleObject.shape.radius <= 0) {
          error(`${path}.shape.radius`, 'radius must be finite and positive');
        }
      } else if (castleObject.shape.kind === 'polygon') {
        if (!Array.isArray(castleObject.shape.vertices) || castleObject.shape.vertices.length < 3) {
          error(`${path}.shape.vertices`, 'vertices must contain at least three points');
        } else {
          castleObject.shape.vertices.forEach((vertex, vertexIndex) => {
            if (!isRecord(vertex) || !Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) {
              error(`${path}.shape.vertices.${vertexIndex}`, 'vertices must contain finite x and y coordinates');
            }
          });
          let direction = 0;
          let doubleArea = 0;
          for (let vertexIndex = 0; vertexIndex < castleObject.shape.vertices.length; vertexIndex += 1) {
            const first = castleObject.shape.vertices[vertexIndex];
            const second = castleObject.shape.vertices[(vertexIndex + 1) % castleObject.shape.vertices.length];
            const third = castleObject.shape.vertices[(vertexIndex + 2) % castleObject.shape.vertices.length];
            if (![first, second, third].every((vertex) => isRecord(vertex) && Number.isFinite(vertex.x) && Number.isFinite(vertex.y))) continue;
            doubleArea += first.x * second.y - second.x * first.y;
            const cross = (second.x - first.x) * (third.y - second.y) - (second.y - first.y) * (third.x - second.x);
            const repeatedEdge = Math.hypot(second.x - first.x, second.y - first.y) < 1e-9;
            const changesDirection = Math.abs(cross) >= 1e-9 && direction !== 0 && Math.sign(cross) !== direction;
            if (repeatedEdge || changesDirection) {
              error(`${path}.shape.vertices`, 'polygon must be non-degenerate and convex');
              break;
            }
            if (Math.abs(cross) >= 1e-9) direction = Math.sign(cross);
          }
          if (!direction || Math.abs(doubleArea) < 1e-9) error(`${path}.shape.vertices`, 'polygon must have non-zero area');
        }
      } else {
        error(`${path}.shape.kind`, `Unknown shape kind: ${castleObject.shape.kind}`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
