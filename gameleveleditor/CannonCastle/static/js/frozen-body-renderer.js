import { traceShape } from './material-renderer.js';

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

export function frozenCrackSegments(frozenId, hitPoint) {
  const origin = {
    x: Number.isFinite(hitPoint?.x) ? hitPoint.x : 0,
    y: Number.isFinite(hitPoint?.y) ? hitPoint.y : 0,
  };
  const random = seededRandom(hashString(frozenId));
  const segments = [];
  const branchCount = 5;
  const phase = random() * Math.PI * 2;

  for (let index = 0; index < branchCount; index += 1) {
    const angle = phase + index * Math.PI * 2 / branchCount + (random() - 0.5) * 0.45;
    const middleLength = 0.22 + random() * 0.12;
    const endLength = middleLength + 0.18 + random() * 0.16;
    const middle = {
      x: origin.x + Math.cos(angle) * middleLength,
      y: origin.y + Math.sin(angle) * middleLength,
    };
    const end = {
      x: origin.x + Math.cos(angle + (random() - 0.5) * 0.35) * endLength,
      y: origin.y + Math.sin(angle + (random() - 0.5) * 0.35) * endLength,
    };
    segments.push({ from: { ...origin }, to: middle });
    segments.push({ from: middle, to: end });
  }

  return segments;
}

function memberShape(member, assets) {
  return member?.shape ?? assets?.shapes?.[member?.shapePresetId]?.shape;
}

function fallbackHitPoint(members) {
  const positioned = members.filter(member => Number.isFinite(member?.x) && Number.isFinite(member?.y));
  if (!positioned.length) return { x: 0, y: 0 };
  return {
    x: positioned.reduce((total, member) => total + member.x, 0) / positioned.length,
    y: positioned.reduce((total, member) => total + member.y, 0) / positioned.length,
  };
}

export function drawFrozenBodyOverlay(context, {
  group,
  members,
  state = 'intact',
  hitPoint = null,
  assets = {},
}) {
  if (state === 'released') return;

  const memberIds = new Set(Array.isArray(group?.memberIds) ? group.memberIds : []);
  const visibleMembers = (Array.isArray(members) ? members : [])
    .filter(member => memberIds.has(member?.id));

  for (const member of visibleMembers) {
    const shape = memberShape(member, assets);
    if (!shape) continue;
    context.save();
    context.translate(member.x, member.y);
    context.rotate(Number(member.angle || 0));
    traceShape(context, shape);
    context.fillStyle = 'rgba(87, 193, 255, 0.32)';
    context.fill();
    context.strokeStyle = 'rgba(196, 244, 255, 0.92)';
    context.lineWidth = 0.055;
    context.stroke();
    context.restore();
  }

  if (state !== 'cracked') return;
  const crackOrigin = hitPoint ?? fallbackHitPoint(visibleMembers);
  context.save();
  context.strokeStyle = 'rgba(255, 255, 255, 0.94)';
  context.lineWidth = 0.045;
  context.beginPath();
  for (const segment of frozenCrackSegments(group?.id, crackOrigin)) {
    context.moveTo(segment.from.x, segment.from.y);
    context.lineTo(segment.to.x, segment.to.y);
  }
  context.stroke();
  context.restore();
}
