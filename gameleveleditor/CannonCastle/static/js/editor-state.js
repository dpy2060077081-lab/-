import { cloneLevel, patchLevel } from './level-config.js';

const COMPLETE_OBJECT_FIELDS = Object.freeze([
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
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function freezeLevel(level) {
  return deepFreeze(cloneLevel(level));
}

function uniqueExistingIds(ids, level) {
  const existing = new Set(level.castle.map((object) => object.id));
  return [...new Set(ids ?? [])].filter((id) => existing.has(id));
}

function combineSelection(selection, ids, mode) {
  if (mode === 'add') return [...new Set([...selection, ...ids])];
  if (mode === 'toggle') {
    const next = new Set(selection);
    for (const id of ids) next.has(id) ? next.delete(id) : next.add(id);
    return [...next];
  }
  return [...ids];
}

function snap(value, gridSize) {
  return Math.round(value / gridSize) * gridSize;
}

function sameSelection(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameLevel(left, right) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function objectVertices(object) {
  const shape = object.shape ?? {};
  const points = shape.kind === 'polygon' && Array.isArray(shape.vertices)
    ? shape.vertices
    : [
      { x: -(shape.width ?? 0.5) / 2, y: -(shape.height ?? 0.5) / 2 },
      { x: (shape.width ?? 0.5) / 2, y: -(shape.height ?? 0.5) / 2 },
      { x: (shape.width ?? 0.5) / 2, y: (shape.height ?? 0.5) / 2 },
      { x: -(shape.width ?? 0.5) / 2, y: (shape.height ?? 0.5) / 2 },
    ];
  // Legacy level files store angles in radians; never translate this value.
  const angle = object.angle || 0;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return points.map((point) => ({
    x: object.x + point.x * cosine - point.y * sine,
    y: object.y + point.x * sine + point.y * cosine,
  }));
}

export function objectBounds(object) {
  const shape = object.shape ?? {};
  if (shape.kind === 'circle') {
    const radius = shape.radius ?? 0.25;
    return { left: object.x - radius, right: object.x + radius, top: object.y - radius, bottom: object.y + radius };
  }
  const transformed = objectVertices(object);
  const xs = transformed.map((point) => point.x);
  const ys = transformed.map((point) => point.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

function pointInPolygon(point, vertices) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const current = vertices[index];
    const prior = vertices[previous];
    if ((current.y > point.y) !== (prior.y > point.y)
      && point.x < ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y) + current.x) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  return Math.sign((b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y));
}

function segmentsIntersect(a, b, c, d) {
  return orientation(a, b, c) !== orientation(a, b, d) && orientation(c, d, a) !== orientation(c, d, b);
}

export function objectContainsPoint(object, point) {
  if (object.shape?.kind === 'circle') {
    const radius = object.shape.radius ?? 0.25;
    return Math.hypot(point.x - object.x, point.y - object.y) <= radius;
  }
  return pointInPolygon(point, objectVertices(object));
}

export function objectIntersectsBox(object, box) {
  if (object.shape?.kind === 'circle') {
    const nearestX = Math.max(box.left, Math.min(object.x, box.right));
    const nearestY = Math.max(box.top, Math.min(object.y, box.bottom));
    return Math.hypot(object.x - nearestX, object.y - nearestY) <= (object.shape.radius ?? 0.25);
  }
  const polygon = objectVertices(object);
  const rectangle = [
    { x: box.left, y: box.top }, { x: box.right, y: box.top },
    { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom },
  ];
  if (polygon.some((point) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom)) return true;
  if (rectangle.some((point) => pointInPolygon(point, polygon))) return true;
  for (let polygonIndex = 0; polygonIndex < polygon.length; polygonIndex += 1) {
    const nextPolygon = (polygonIndex + 1) % polygon.length;
    for (let rectangleIndex = 0; rectangleIndex < rectangle.length; rectangleIndex += 1) {
      const nextRectangle = (rectangleIndex + 1) % rectangle.length;
      if (segmentsIntersect(polygon[polygonIndex], polygon[nextPolygon], rectangle[rectangleIndex], rectangle[nextRectangle])) return true;
    }
  }
  return false;
}

function assertCompleteObject(object) {
  if (!isRecord(object) || COMPLETE_OBJECT_FIELDS.some((field) => !Object.hasOwn(object, field))) {
    throw new TypeError('Added castle objects must use the complete object structure');
  }
  if (typeof object.id !== 'string' || object.id.length === 0) {
    throw new TypeError('Added castle objects require a non-empty id');
  }
}

function nextCopyId(sourceId, existingIds) {
  const base = `${sourceId}-copy`;
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function patchSelected(level, selection, updates) {
  if (!isRecord(updates)) throw new TypeError('Selected-object updates must be an object');
  const selected = new Set(selection);
  const paths = {};
  level.castle.forEach((object, index) => {
    if (!selected.has(object.id)) return;
    for (const [path, value] of Object.entries(updates)) paths[`castle.${index}.${path}`] = value;
  });
  return Object.keys(paths).length === 0 ? level : patchLevel(level, paths);
}

function moveSelected(level, selection, command, gridSize) {
  const selected = new Set(selection);
  const paths = {};
  level.castle.forEach((object, index) => {
    if (!selected.has(object.id)) return;
    const x = object.x + (Number(command.dx) || 0);
    const y = object.y + (Number(command.dy) || 0);
    paths[`castle.${index}.x`] = command.snap === false ? x : snap(x, gridSize);
    paths[`castle.${index}.y`] = command.snap === false ? y : snap(y, gridSize);
  });
  return Object.keys(paths).length === 0 ? level : patchLevel(level, paths);
}

function alignSelected(level, selection, axis, gridSize) {
  const selected = new Set(selection);
  const objects = level.castle.filter((object) => selected.has(object.id));
  if (objects.length < 2) return level;
  const coordinate = axis === 'center-x' ? 'x' : axis === 'center-y' ? 'y' : null;
  if (!coordinate) throw new TypeError(`Unsupported alignment axis: ${axis}`);
  const sorted = objects.map((object) => object[coordinate]).sort((left, right) => left - right);
  const target = snap(sorted[Math.floor((sorted.length - 1) / 2)], gridSize);
  const updates = {};
  level.castle.forEach((object, index) => {
    if (selected.has(object.id)) updates[`castle.${index}.${coordinate}`] = target;
  });
  return patchLevel(level, updates);
}

function applyEdit(level, selection, command, gridSize) {
  switch (command.type) {
    case 'patch':
      return { level: patchLevel(level, command.updates), selection };
    case 'patchSelected':
      return { level: patchSelected(level, selection, command.updates), selection };
    case 'move':
      return { level: moveSelected(level, selection, command, gridSize), selection };
    case 'align':
      return { level: alignSelected(level, selection, command.axis, gridSize), selection };
    case 'add': {
      assertCompleteObject(command.object);
      if (level.castle.some((object) => object.id === command.object.id)) {
        throw new RangeError(`Castle object ids must be unique: ${command.object.id}`);
      }
      const object = cloneLevel(command.object);
      return {
        level: { ...level, castle: [...level.castle, object] },
        selection: [object.id],
      };
    }
    case 'duplicate': {
      const selected = new Set(selection);
      const existingIds = new Set(level.castle.map((object) => object.id));
      const copies = level.castle.filter((object) => selected.has(object.id)).map((object) => {
        const copy = cloneLevel(object);
        copy.id = nextCopyId(object.id, existingIds);
        existingIds.add(copy.id);
        copy.x = snap(copy.x + (Number(command.offset?.x) || gridSize), gridSize);
        copy.y = snap(copy.y + (Number(command.offset?.y) || gridSize), gridSize);
        return copy;
      });
      return copies.length === 0 ? { level, selection } : {
        level: { ...level, castle: [...level.castle, ...copies] },
        selection: copies.map((object) => object.id),
      };
    }
    case 'delete': {
      const selected = new Set(selection);
      if (selected.size === 0) return { level, selection };
      return {
        level: { ...level, castle: level.castle.filter((object) => !selected.has(object.id)) },
        selection: [],
      };
    }
    default:
      throw new TypeError(`Unsupported editor command: ${command.type}`);
  }
}

/**
 * Creates the pure, command-based draft boundary used by both the canvas and
 * the inspector. Level edits are immutable; view-only selection is excluded
 * from history and dirty tracking.
 */
export function createEditorState(level, { historyLimit = 100, gridSize = 0.25 } = {}) {
  if (!isRecord(level) || !Array.isArray(level.castle)) throw new TypeError('Editor state requires a level with a castle array');
  if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new RangeError('historyLimit must be a positive integer');
  if (!Number.isFinite(gridSize) || gridSize <= 0) throw new RangeError('gridSize must be positive');

  let current = Object.freeze({ level: freezeLevel(level), selection: Object.freeze([]), revision: 0 });
  let cleanRevision = 0;
  let nextRevision = 1;
  let undoStack = [];
  let redoStack = [];
  const subscribers = new Set();

  const publicSnapshot = () => Object.freeze({
    level: current.level,
    selection: current.selection,
    revision: current.revision,
    dirty: current.revision !== cleanRevision,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  });
  const notify = () => {
    const snapshot = publicSnapshot();
    for (const subscriber of subscribers) subscriber(snapshot);
  };
  const setCurrent = (snapshot) => {
    current = Object.freeze({
      level: snapshot.level,
      selection: Object.freeze([...snapshot.selection]),
      revision: snapshot.revision,
    });
  };

  const api = {
    get level() { return current.level; },
    get selection() { return [...current.selection]; },
    get dirty() { return current.revision !== cleanRevision; },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get snapshot() { return publicSnapshot(); },
    dispatch(command) {
      if (!isRecord(command) || typeof command.type !== 'string') throw new TypeError('Editor commands require a type');
      if (command.type === 'select' || command.type === 'selectBox') {
        const ids = command.type === 'select'
          ? uniqueExistingIds(command.ids, current.level)
          : current.level.castle.filter((object) => objectIntersectsBox(object, command.bounds ?? {})).map((object) => object.id);
        setCurrent({ ...current, selection: combineSelection(current.selection, ids, command.mode) });
        notify();
        return publicSnapshot();
      }

      const before = current;
      const result = applyEdit(current.level, current.selection, command, gridSize);
      if (sameLevel(result.level, current.level) && sameSelection(result.selection, current.selection)) return publicSnapshot();
      const after = Object.freeze({
        level: freezeLevel(result.level),
        selection: Object.freeze([...result.selection]),
        revision: nextRevision++,
      });
      undoStack = [...undoStack, Object.freeze({ before, after })].slice(-historyLimit);
      redoStack = [];
      current = after;
      notify();
      return publicSnapshot();
    },
    undo() {
      const entry = undoStack.at(-1);
      if (!entry) return false;
      undoStack = undoStack.slice(0, -1);
      redoStack = [...redoStack, entry];
      current = entry.before;
      notify();
      return true;
    },
    redo() {
      const entry = redoStack.at(-1);
      if (!entry) return false;
      redoStack = redoStack.slice(0, -1);
      undoStack = [...undoStack, entry].slice(-historyLimit);
      current = entry.after;
      notify();
      return true;
    },
    markClean(revision = current.revision) {
      if (!Number.isInteger(revision) || revision < 0) throw new RangeError('Clean revision must be a non-negative integer');
      cleanRevision = revision;
      notify();
    },
    subscribe(subscriber) {
      if (typeof subscriber !== 'function') throw new TypeError('Editor subscribers must be functions');
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
  return Object.freeze(api);
}

export { COMPLETE_OBJECT_FIELDS };
