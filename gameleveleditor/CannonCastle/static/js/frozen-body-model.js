import { objectBounds, rotatedVertices, shapesOverlap } from './placement-collision.js';

const DEFAULT_TOLERANCE = 0.02;
const MAX_ADJACENT_GAP = 0.25;

export function normalizeFrozenBodies(level = {}) {
  return Array.isArray(level.frozenBodies)
    ? level.frozenBodies.map(group => ({ id: group?.id, memberIds: Array.isArray(group?.memberIds) ? [...group.memberIds] : [] }))
    : [];
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function polygonDistance(left, right) {
  let distance = Infinity;
  const visit = (points, segments) => {
    for (const point of points) {
      for (let index = 0; index < segments.length; index += 1) {
        distance = Math.min(distance, pointSegmentDistance(
          point,
          segments[index],
          segments[(index + 1) % segments.length],
        ));
      }
    }
  };
  visit(left, right);
  visit(right, left);
  return distance;
}

function shapeDistance(a, b) {
  if (shapesOverlap(a, b)) return 0;
  if (a.shape.kind === 'circle' && b.shape.kind === 'circle') {
    return Math.max(0, Math.hypot(a.x - b.x, a.y - b.y) - a.shape.radius - b.shape.radius);
  }
  if (a.shape.kind === 'circle' || b.shape.kind === 'circle') {
    const circle = a.shape.kind === 'circle' ? a : b;
    const polygon = a.shape.kind === 'circle' ? b : a;
    const vertices = rotatedVertices(polygon);
    let centerDistance = Infinity;
    for (let index = 0; index < vertices.length; index += 1) {
      centerDistance = Math.min(centerDistance, pointSegmentDistance(
        circle,
        vertices[index],
        vertices[(index + 1) % vertices.length],
      ));
    }
    return Math.max(0, centerDistance - circle.shape.radius);
  }
  return polygonDistance(rotatedVertices(a), rotatedVertices(b));
}

function boundsAdjacent(left, right, tolerance) {
  const horizontalContact = Math.abs(left.maxX - right.minX) <= tolerance
    || Math.abs(right.maxX - left.minX) <= tolerance;
  const verticalContact = Math.abs(left.maxY - right.minY) <= tolerance
    || Math.abs(right.maxY - left.minY) <= tolerance;
  const horizontalRangesMeet = left.minX <= right.maxX + tolerance && right.minX <= left.maxX + tolerance;
  const verticalRangesMeet = left.minY <= right.maxY + tolerance && right.minY <= left.maxY + tolerance;
  return (horizontalContact && verticalRangesMeet) || (verticalContact && horizontalRangesMeet);
}

function connected(a, b, tolerance) {
  const left = objectBounds(a);
  const right = objectBounds(b);
  const adjacentDistance = MAX_ADJACENT_GAP + Number.EPSILON;
  const boundsNear = left.minX <= right.maxX + adjacentDistance && right.minX <= left.maxX + adjacentDistance
    && left.minY <= right.maxY + adjacentDistance && right.minY <= left.maxY + adjacentDistance;
  return boundsNear && (shapeDistance(a, b) <= adjacentDistance
    || boundsAdjacent(left, right, tolerance));
}

export function validateFrozenBodies(level = {}, assets = {}, { contactTolerance = DEFAULT_TOLERANCE } = {}) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  const groups = normalizeFrozenBodies(level);
  const objects = Array.isArray(level.castle) ? level.castle : [];
  const byId = new Map(objects.map(object => [object?.id, object]));
  const objectIds = new Set(objects.map(object => object?.id));
  const claimed = new Map();
  const ids = new Set();
  groups.forEach((group, groupIndex) => {
    const groupPath = typeof group.id === 'string' && group.id ? group.id : String(groupIndex);
    if (typeof group.id !== 'string' || !group.id) add(`frozenBodies.${groupPath}.id`, '冰冻体 ID 不能为空');
    else if (ids.has(group.id)) add(`frozenBodies.${group.id}.id`, '冰冻体 ID 必须唯一');
    else {
      ids.add(group.id);
      if (objectIds.has(group.id)) add(`frozenBodies.${group.id}.id`, '冰冻体 ID 不能与城堡物件 ID 重复');
    }
    if (!group.memberIds.length) add(`frozenBodies.${groupPath}.memberIds`, '成员不能为空');
    const members = [];
    const memberIds = new Set();
    group.memberIds.forEach(memberId => {
      const path = `frozenBodies.${groupPath}.memberIds.${memberId}`;
      if (memberIds.has(memberId)) add(path, '成员不能重复');
      memberIds.add(memberId);
      const member = byId.get(memberId);
      if (!member) { add(path, '成员物件不存在'); return; }
      if (claimed.has(memberId)) add(path, `物件已属于冰冻体 ${claimed.get(memberId)}`);
      else claimed.set(memberId, group.id);
      if (member.fixedBolt === true) add(path, '固定螺栓物件不能加入冰冻体');
      const shape = member.shape ?? assets.shapes?.[member.shapePresetId]?.shape;
      if (!shape) { add(path, '成员形状无效'); return; }
      members.push({ ...member, shape });
    });
    if (members.length > 1) {
      const seen = new Set([members[0].id]);
      const pending = [members[0]];
      while (pending.length) {
        const current = pending.pop();
        for (const candidate of members) if (!seen.has(candidate.id) && connected(current, candidate, contactTolerance)) {
          seen.add(candidate.id); pending.push(candidate);
        }
      }
      for (const member of members) if (!seen.has(member.id)) add(`frozenBodies.${groupPath}.memberIds.${member.id}`, '成员必须彼此接触并构成单一连通体');
    }
  });
  return { valid: errors.length === 0, errors };
}

export function frozenMembership(level = {}) {
  const membership = new Map();
  for (const group of normalizeFrozenBodies(level)) for (const memberId of group.memberIds) membership.set(memberId, group.id);
  return membership;
}

export function expandFrozenSelection(level, selectedIds = []) {
  const membership = frozenMembership(level);
  const result = new Set(selectedIds);
  for (const group of normalizeFrozenBodies(level)) if (group.memberIds.some(id => result.has(id))) group.memberIds.forEach(id => result.add(id));
  return [...result];
}

function nextId(level, groups) {
  const used = new Set([
    ...(Array.isArray(level.castle) ? level.castle.map(object => object?.id) : []),
    ...groups.map(group => group.id),
  ]);
  let index = groups.length + 1;
  while (used.has(`frozen-${index}`)) index += 1;
  return `frozen-${index}`;
}

export function createFrozenBody(level, memberIds) {
  const groups = normalizeFrozenBodies(level);
  const id = nextId(level, groups);
  return { level: { ...level, frozenBodies: [...groups, { id, memberIds: [...memberIds] }] }, frozenBodyId: id };
}

export function removeFrozenBodies(level, selectedIds = []) {
  const selected = new Set(selectedIds);
  const membership = frozenMembership(level);
  const ids = new Set([...selected].map(id => membership.get(id) ?? id));
  return { ...level, frozenBodies: normalizeFrozenBodies(level).filter(group => !ids.has(group.id)) };
}
