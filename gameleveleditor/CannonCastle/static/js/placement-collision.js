/** Demo-faithful level-placement rules: support-surface snapping, boundary clamping, and non-overlapping duplicate placement.
 *
 * Ported from the original meteor-castle editor (Du class helpers zu / Ru / Vu / si / fs / Ps / Eu).
 * All coordinates are world units in a Y-down screen space (y grows downward; an object rests ON the
 * platform top at PLATFORM_TOP_Y). The module is pure: no DOM, no side effects at import.
 */

const SUPPORT_SNAP_DISTANCE = 0.32;    // Su — vertical distance at which an object settles onto a support top
const SUPPORT_SNAP_X = 0.16;           // to — horizontal distance at which an object snaps to a support center/edge
const WORLD_MIN_X = 0;                 // buildable area left wall
const WORLD_MAX_X = 9;                 // buildable area right wall
const PLATFORM_TOP_Y = 12.34;          // xs — platform top surface Y
const DRAG_MIN_X = 0.2;                // zu lower clamp for a dragged object center
const DRAG_MAX_X = 8.8;
const DRAG_MIN_Y = 1.8;
const DRAG_MAX_Y = 12.1;
const NUDGE_MIN_X = 0.1;               // nudgeSelected clamp for an object center
const NUDGE_MAX_X = 8.9;
const NUDGE_MIN_Y = 1.6;
const NUDGE_MAX_Y = 12.2;
const PLACEMENT_MIN_X = 0.15;          // Zn — free-spot bounds (full object AABB)
const PLACEMENT_MAX_X = 8.85;          // Jn
const PLACEMENT_MIN_Y = 1.65;          // Qn
const PLACEMENT_MAX_Y = PLATFORM_TOP_Y; // _n (Demo uses 12.25) relaxed so platform-resting objects can be duplicated
const DUPLICATE_GAP = 0.45;            // ps — clearance between a duplicate and its original
const DUPLICATE_STEP = 0.25;           // Di — spiral search step
const OVERLAP_TOLERANCE = 1e-6;        // Tt
const SUPPORT_GROUP_TOLERANCE = 0.08;  // two box tops within this Y are treated as one shared surface
const SUPPORT_MIN_OVERLAP = 0.08;      // minimum horizontal span an object must share with a support
const SUPPORT_CONTACT_TOLERANCE = 0.015; // existing 0.01m physics skin gap plus float tolerance
const SUPPORT_MAX_EMBED = 0.03;         // historical direct parent/child seam embed

export const placementConstants = Object.freeze({
  SUPPORT_SNAP_DISTANCE,
  SUPPORT_SNAP_X,
  WORLD_MIN_X,
  WORLD_MAX_X,
  PLATFORM_TOP_Y,
  PLACEMENT_MIN_X,
  PLACEMENT_MAX_X,
  PLACEMENT_MIN_Y,
  PLACEMENT_MAX_Y,
  DUPLICATE_GAP,
  DUPLICATE_STEP,
  OVERLAP_TOLERANCE,
  SUPPORT_GROUP_TOLERANCE,
  SUPPORT_MIN_OVERLAP,
  SUPPORT_CONTACT_TOLERANCE,
  SUPPORT_MAX_EMBED,
});

/** Local (pre-rotation) outline vertices of a shape, expanding rounded corners like the Demo's Lo(). */
export function localVertices(shape) {
  const vertices = shape.kind === "box"
    ? [
      { x: -shape.width / 2, y: -shape.height / 2 },
      { x: shape.width / 2, y: -shape.height / 2 },
      { x: shape.width / 2, y: shape.height / 2 },
      { x: -shape.width / 2, y: shape.height / 2 },
    ]
    : shape.vertices;
  const cornerRadius = shape.cornerRadius;
  if (!cornerRadius) return vertices;
  return vertices.flatMap((vertex, index) => {
    const previous = vertices[(index - 1 + vertices.length) % vertices.length];
    const next = vertices[(index + 1) % vertices.length];
    const previousLength = Math.hypot(previous.x - vertex.x, previous.y - vertex.y);
    const nextLength = Math.hypot(next.x - vertex.x, next.y - vertex.y);
    const inset = Math.min(cornerRadius, previousLength * 0.32, nextLength * 0.32);
    return [
      { x: vertex.x + (previous.x - vertex.x) * inset / previousLength, y: vertex.y + (previous.y - vertex.y) * inset / previousLength },
      { x: vertex.x + (next.x - vertex.x) * inset / nextLength, y: vertex.y + (next.y - vertex.y) * inset / nextLength },
    ];
  });
}

/** World-space outline vertices of a polygon/box object; returns [] for circles. */
export function rotatedVertices(object) {
  if (object.shape.kind === "circle") return [];
  const angle = Number(object.angle) || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return localVertices(object.shape).map(vertex => ({
    x: object.x + vertex.x * cos - vertex.y * sin,
    y: object.y + vertex.x * sin + vertex.y * cos,
  }));
}

/** Axis-aligned bounding box of an object ({minX, maxX, minY, maxY}). */
export function objectBounds(object) {
  if (object.shape.kind === "circle") {
    return {
      minX: object.x - object.shape.radius,
      maxX: object.x + object.shape.radius,
      minY: object.y - object.shape.radius,
      maxY: object.y + object.shape.radius,
    };
  }
  const vertices = rotatedVertices(object);
  return {
    minX: Math.min(...vertices.map(point => point.x)),
    maxX: Math.max(...vertices.map(point => point.x)),
    minY: Math.min(...vertices.map(point => point.y)),
    maxY: Math.max(...vertices.map(point => point.y)),
  };
}

/** Whether a support-like object is a horizontal surface (near-upright boxes only). */
export function isSupportSurface(object) {
  return object.shape.kind === "box"
    && Math.abs(((Number(object.angle) || 0) + Math.PI / 2) % Math.PI - Math.PI / 2) < 5 * Math.PI / 180;
}

/** Fixed platform supports described by the level environment. */
export function environmentSupports(environment = {}) {
  if (environment.platformType === "single-3") return [{ centerX: 4.5, width: 3 }];
  if (environment.platformType === "single-5") return [{ centerX: 4.5, width: 5 }];
  if (environment.platformType === "double-2" || environment.platformType === "double-3") {
    const width = environment.platformType === "double-2" ? 2 : 3;
    const offset = 0.4 + width / 2;
    return [{ centerX: 4.5 - offset, width }, { centerX: 4.5 + offset, width }];
  }
  const width = Number(environment.baseWidth);
  return Number.isFinite(width) && width > 0 ? [{ centerX: 4.5, width }] : [];
}

// --- Demo SAT primitives ($n / Tu / Mu) ---------------------------------------------------------

function projectOverlap(pointsA, pointsB, axis) {
  const length = Math.hypot(axis.x, axis.y);
  if (length <= OVERLAP_TOLERANCE) return true;
  const normalX = axis.x / length; const normalY = axis.y / length;
  let minA = Infinity; let maxA = -Infinity; let minB = Infinity; let maxB = -Infinity;
  for (const point of pointsA) {
    const projection = point.x * normalX + point.y * normalY;
    minA = Math.min(minA, projection); maxA = Math.max(maxA, projection);
  }
  for (const point of pointsB) {
    const projection = point.x * normalX + point.y * normalY;
    minB = Math.min(minB, projection); maxB = Math.max(maxB, projection);
  }
  return Math.min(maxA, maxB) - Math.max(minA, minB) > OVERLAP_TOLERANCE;
}

function polygonsOverlap(pointsA, pointsB) {
  for (const points of [pointsA, pointsB]) {
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      if (!projectOverlap(pointsA, pointsB, { x: current.y - next.y, y: next.x - current.x })) return false;
    }
  }
  return true;
}

function circleVsPolygon(center, radius, vertices) {
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    const axis = { x: current.y - next.y, y: next.x - current.x };
    const length = Math.hypot(axis.x, axis.y);
    if (length <= OVERLAP_TOLERANCE) continue;
    const normal = { x: axis.x / length, y: axis.y / length };
    const projections = vertices.map(vertex => vertex.x * normal.x + vertex.y * normal.y);
    const centerProjection = center.x * normal.x + center.y * normal.y;
    if (Math.min(Math.max(...projections), centerProjection + radius)
      - Math.max(Math.min(...projections), centerProjection - radius) <= OVERLAP_TOLERANCE) return false;
  }
  const closest = vertices.reduce((best, vertex) =>
    (vertex.x - center.x) ** 2 + (vertex.y - center.y) ** 2 < (best.x - center.x) ** 2 + (best.y - center.y) ** 2 ? vertex : best);
  const delta = { x: closest.x - center.x, y: closest.y - center.y };
  const deltaLength = Math.hypot(delta.x, delta.y);
  if (deltaLength <= OVERLAP_TOLERANCE) return true;
  const normal = { x: delta.x / deltaLength, y: delta.y / deltaLength };
  const projections = vertices.map(vertex => vertex.x * normal.x + vertex.y * normal.y);
  const centerProjection = center.x * normal.x + center.y * normal.y;
  return Math.min(Math.max(...projections), centerProjection + radius)
    - Math.max(Math.min(...projections), centerProjection - radius) > OVERLAP_TOLERANCE;
}

/** True when two objects physically overlap. Exact resting contact (bottom === support top) is NOT an overlap. */
export function shapesOverlap(a, b) {
  if (a.shape.kind === "circle" && b.shape.kind === "circle") {
    return Math.hypot(a.x - b.x, a.y - b.y) < a.shape.radius + b.shape.radius - OVERLAP_TOLERANCE;
  }
  if (a.shape.kind === "circle") return circleVsPolygon({ x: a.x, y: a.y }, a.shape.radius, rotatedVertices(b));
  if (b.shape.kind === "circle") return circleVsPolygon({ x: b.x, y: b.y }, b.shape.radius, rotatedVertices(a));
  return polygonsOverlap(rotatedVertices(a), rotatedVertices(b));
}

/** True when an object's real rotated/circular geometry intersects an axis-aligned cell area. */
export function shapeIntersectsBounds(object, bounds, objectVertices, boundsVertices) {
  const cellVertices = boundsVertices ?? [
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ];
  if (object.shape.kind === 'circle') return circleVsPolygon({ x: object.x, y: object.y }, object.shape.radius, cellVertices);
  return polygonsOverlap(objectVertices ?? rotatedVertices(object), cellVertices);
}

// --- Demo zu(): support-surface snapping -------------------------------------------------------

/** Clamp + snap a placement point onto the nearest support surface (platform or box top) below it.
 *
 * `objects` is the full castle; the anchor is found by id for its shape only. Supports are any
 * horizontal box not in `excludeIds`, plus the environment platforms. Returns the snapped center
 * position ({x, y, snapped: false} when nothing is within SUPPORT_SNAP_DISTANCE).
 */
export function supportSnap({ objects = [], environment = {}, anchorId, x, y, excludeIds = new Set() } = {}) {
  const anchor = objects.find(object => object.id === anchorId);
  if (!anchor) return { x, y, snapped: false };
  let o = Math.min(DRAG_MAX_X, Math.max(DRAG_MIN_X, Number(x)));
  let n = Math.min(DRAG_MAX_Y, Math.max(DRAG_MIN_Y, Number(y)));
  const probe = { ...anchor, x: o, y: n };
  const bounds = objectBounds(probe);
  const halfWidth = (bounds.maxX - bounds.minX) / 2;
  const halfHeight = (bounds.maxY - bounds.minY) / 2;
  const boxSupports = objects
    .filter(object => !excludeIds.has(object.id) && isSupportSurface(object))
    .map(object => ({ piece: object, bounds: objectBounds(object) }))
    .filter(({ bounds: supportBounds }) =>
      Math.min(bounds.maxX, supportBounds.maxX) - Math.max(bounds.minX, supportBounds.minX) > SUPPORT_MIN_OVERLAP
      && supportBounds.minY > n)
    .map(({ piece, bounds: supportBounds }) => ({ top: supportBounds.minY, center: piece.x, minX: supportBounds.minX, maxX: supportBounds.maxX }));
  const grouped = boxSupports.flatMap((support, index) => {
    const sameHeight = boxSupports.filter((other, otherIndex) => otherIndex !== index
      && Math.abs(other.top - support.top) <= SUPPORT_GROUP_TOLERANCE
      && other.minX <= support.maxX + Math.max(halfWidth, 0.4)
      && other.maxX >= support.minX - Math.max(halfWidth, 0.4));
    if (sameHeight.length === 0) return [];
    const group = [support, ...sameHeight];
    const minX = Math.min(...group.map(entry => entry.minX));
    const maxX = Math.max(...group.map(entry => entry.maxX));
    return [{ top: support.top, center: (minX + maxX) / 2, minX, maxX, multi: true }];
  });
  const allSupports = [
    ...environmentSupports(environment).map(platform => ({
      top: PLATFORM_TOP_Y,
      center: platform.centerX,
      minX: platform.centerX - platform.width / 2,
      maxX: platform.centerX + platform.width / 2,
      multi: false,
    })),
    ...grouped,
    ...boxSupports.map(support => ({ ...support, multi: false })),
  ].filter(({ minX, maxX }) => o + halfWidth > minX && o - halfWidth < maxX);
  const bottom = n + halfHeight;
  const nearest = allSupports
    .map(support => ({ value: support, distance: Math.abs(bottom - support.top) }))
    .filter(({ distance }) => distance <= SUPPORT_SNAP_DISTANCE)
    .sort((left, right) => left.distance - right.distance)[0]?.value;
  if (!nearest) {
    const final = keepInBounds(o, halfWidth, n, halfHeight);
    return { x: final.x, y: final.y, snapped: false };
  }
  n = nearest.top - halfHeight;
  const centerOffset = Math.abs(o - nearest.center);
  const snapTargets = nearest.multi && centerOffset <= SUPPORT_SNAP_X
    ? [nearest.center]
    : [nearest.center, nearest.minX + halfWidth, nearest.maxX - halfWidth];
  const snappedX = snapTargets
    .map(candidate => ({ value: candidate, distance: Math.abs(o - candidate) }))
    .filter(({ distance }) => distance <= SUPPORT_SNAP_X)
    .sort((left, right) => left.distance - right.distance)[0]?.value;
  if (snappedX !== undefined) o = snappedX;
  const final = keepInBounds(o, halfWidth, n, halfHeight);
  return { x: final.x, y: final.y, snapped: true };
}

// Keep the object's AABB inside the buildable area so it can never penetrate the floor (bottom 12.34)
// or the side walls (x in [0, 9]). The top is left free to match the Demo's loose center clamp.
function keepInBounds(o, halfWidth, n, halfHeight) {
  return {
    x: Math.min(WORLD_MAX_X - halfWidth, Math.max(WORLD_MIN_X + halfWidth, o)),
    y: Math.min(PLATFORM_TOP_Y - halfHeight, n),
  };
}

/** Clamp a drag translation so the moving objects can never overlap a resting object or leave the buildable area.
 * Returns the largest legal fraction of the requested (dx, dy) that keeps every moving object
 * non-overlapping and inside the world, preserving the drag direction. */
export function constrainDrag({ moving = [], resting = [], dx = 0, dy = 0 } = {}) {
  if (moving.length === 0) return { dx: 0, dy: 0 };
  const placed = k => moving.map(object => ({
    ...object,
    x: Number(object.x) + dx * k,
    y: Number(object.y) + dy * k,
  }));
  const legal = k => {
    const positioned = placed(k);
    for (const object of positioned) {
      const spot = objectBounds(object);
      if (spot.minX < WORLD_MIN_X - OVERLAP_TOLERANCE
        || spot.maxX > WORLD_MAX_X + OVERLAP_TOLERANCE
        || spot.maxY > PLATFORM_TOP_Y + OVERLAP_TOLERANCE) return false;
    }
    return positioned.every(object => resting.every(other => !shapesOverlap(object, other)));
  };
  if (legal(1)) return { dx, dy };
  if (!legal(0)) return { dx: 0, dy: 0 };
  let low = 0;
  let high = 1;
  for (let index = 0; index < 12; index += 1) {
    const mid = (low + high) / 2;
    if (legal(mid)) low = mid;
    else high = mid;
  }
  return { dx: dx * low, dy: dy * low };
}

// --- Demo Ru(): non-overlapping duplicate placement ---------------------------------------------

/** Find a translation that moves `selected` into a free, in-bounds spot without overlapping `allObjects`.
 * Returns {x, y} offset or null when no free spot exists. */
export function findFreePlacement(selected, allObjects) {
  if (selected.length === 0) return null;
  const bounds = selected.map(objectBounds);
  const combined = {
    minX: Math.min(...bounds.map(entry => entry.minX)),
    maxX: Math.max(...bounds.map(entry => entry.maxX)),
    minY: Math.min(...bounds.map(entry => entry.minY)),
    maxY: Math.max(...bounds.map(entry => entry.maxY)),
  };
  const width = combined.maxX - combined.minX;
  const height = combined.maxY - combined.minY;
  const selectedIds = new Set(selected.map(object => object.id));
  const others = allObjects.filter(object => !selectedIds.has(object.id));
  const valid = offset => selected
    .map(object => ({ ...object, x: Number(object.x) + offset.x, y: Number(object.y) + offset.y }))
    .every(placed => {
      const spot = objectBounds(placed);
      return spot.minX >= PLACEMENT_MIN_X - OVERLAP_TOLERANCE
        && spot.maxX <= PLACEMENT_MAX_X + OVERLAP_TOLERANCE
        && spot.minY >= PLACEMENT_MIN_Y - OVERLAP_TOLERANCE
        && spot.maxY <= PLACEMENT_MAX_Y + OVERLAP_TOLERANCE
        && others.every(other => !shapesOverlap(placed, other));
    });
  const adjacent = [
    { x: width + DUPLICATE_GAP, y: 0 },
    { x: -(width + DUPLICATE_GAP), y: 0 },
    { x: 0, y: height + DUPLICATE_GAP },
    { x: 0, y: -(height + DUPLICATE_GAP) },
  ];
  for (const candidate of adjacent) {
    const offset = { x: Math.round(candidate.x * 100) / 100, y: Math.round(candidate.y * 100) / 100 };
    if (valid(offset)) return offset;
  }
  const horizontalSteps = Math.ceil(Math.max(PLACEMENT_MAX_X - combined.minX, combined.maxX - PLACEMENT_MIN_X) / DUPLICATE_STEP);
  const verticalSteps = Math.ceil(Math.max(PLACEMENT_MAX_Y - combined.minY, combined.maxY - PLACEMENT_MIN_Y) / DUPLICATE_STEP);
  for (let ring = 1; ring <= horizontalSteps + verticalSteps; ring += 1) {
    const ringCandidates = [];
    for (let step = -ring; step <= ring; step += 1) {
      const vertical = ring - Math.abs(step);
      if (vertical === 0) ringCandidates.push({ x: step * DUPLICATE_STEP, y: 0 });
      else {
        ringCandidates.push({ x: step * DUPLICATE_STEP, y: vertical * DUPLICATE_STEP });
        ringCandidates.push({ x: step * DUPLICATE_STEP, y: -vertical * DUPLICATE_STEP });
      }
    }
    for (const candidate of ringCandidates) if (valid(candidate)) return candidate;
  }
  return null;
}
