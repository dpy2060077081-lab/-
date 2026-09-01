function shapeBounds(shape) {
  if (shape.kind === 'circle') return { left: -shape.radius, right: shape.radius, top: -shape.radius, bottom: shape.radius };
  if (shape.kind === 'box') return { left: -shape.width / 2, right: shape.width / 2, top: -shape.height / 2, bottom: shape.height / 2 };
  return {
    left: Math.min(...shape.vertices.map(vertex => vertex.x)),
    right: Math.max(...shape.vertices.map(vertex => vertex.x)),
    top: Math.min(...shape.vertices.map(vertex => vertex.y)),
    bottom: Math.max(...shape.vertices.map(vertex => vertex.y)),
  };
}

export function traceShape(context, shape) {
  context.beginPath();
  if (shape.kind === 'circle') context.arc(0, 0, shape.radius, 0, Math.PI * 2);
  else if (shape.kind === 'box') context.rect(-shape.width / 2, -shape.height / 2, shape.width, shape.height);
  else {
    context.moveTo(shape.vertices[0].x, shape.vertices[0].y);
    for (const vertex of shape.vertices.slice(1)) context.lineTo(vertex.x, vertex.y);
    context.closePath();
  }
}

function drawWood(context, bounds) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  context.strokeStyle = 'rgba(71,43,24,.38)';
  context.lineWidth = 0.035;
  for (let y = bounds.top + height * 0.25; y < bounds.bottom; y += Math.max(0.18, height * 0.28)) {
    context.beginPath();
    context.moveTo(bounds.left, y);
    context.lineTo(bounds.right, y);
    context.stroke();
  }
  context.strokeStyle = 'rgba(255,230,181,.30)';
  context.lineWidth = 0.022;
  for (let y = bounds.top + height * 0.38; y < bounds.bottom; y += Math.max(0.18, height * 0.28)) {
    context.beginPath();
    context.moveTo(bounds.left + width * 0.08, y);
    context.lineTo(bounds.right - width * 0.1, y + height * 0.025);
    context.stroke();
  }
  context.strokeStyle = 'rgba(255,244,213,.46)';
  context.lineWidth = 0.03;
  context.beginPath();
  context.moveTo(bounds.left, bounds.top + 0.018);
  context.lineTo(bounds.right, bounds.top + 0.018);
  context.moveTo(bounds.left + 0.018, bounds.top);
  context.lineTo(bounds.left + 0.018, bounds.bottom);
  context.stroke();
}

function drawGlass(context, bounds, color) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  context.fillStyle = color || '#79c8c7';
  context.globalAlpha = 0.38;
  context.fillRect(bounds.left, bounds.top, width, height);
  context.globalAlpha = 1;
  context.strokeStyle = 'rgba(151,232,245,.56)';
  context.lineWidth = 0.035;
  const spacing = Math.max(0.16, Math.min(width, height) * 0.38);
  for (let offset = -height; offset <= width + height; offset += spacing) {
    context.beginPath();
    context.moveTo(bounds.left + offset, bounds.bottom);
    context.lineTo(bounds.left + offset + height, bounds.top);
    context.stroke();
  }
  context.strokeStyle = 'rgba(255,255,255,.82)';
  context.lineWidth = 0.045;
  context.beginPath();
  context.moveTo(bounds.left + width * 0.12, bounds.top + height * 0.14);
  context.lineTo(bounds.left + width * 0.56, bounds.bottom - height * 0.12);
  context.stroke();
  context.strokeStyle = 'rgba(218,252,255,.64)';
  context.lineWidth = 0.02;
  context.beginPath();
  const crackX = bounds.left + width * 0.72;
  const crackY = bounds.top + height * 0.42;
  context.moveTo(crackX, crackY);
  context.lineTo(crackX - width * 0.15, crackY - height * 0.2);
  context.moveTo(crackX, crackY);
  context.lineTo(crackX + width * 0.12, crackY + height * 0.18);
  context.moveTo(crackX, crackY);
  context.lineTo(crackX - width * 0.08, crackY + height * 0.24);
  context.stroke();
}

function drawStone(context, bounds) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  context.fillStyle = 'rgba(205,220,231,.14)';
  context.beginPath();
  context.moveTo(bounds.left + width * 0.08, bounds.top + height * 0.18);
  context.lineTo(bounds.left + width * 0.34, bounds.top + height * 0.1);
  context.lineTo(bounds.left + width * 0.42, bounds.top + height * 0.35);
  context.lineTo(bounds.left + width * 0.2, bounds.top + height * 0.48);
  context.closePath();
  context.fill();
  context.strokeStyle = 'rgba(48,55,63,.42)';
  context.lineWidth = 0.04;
  context.beginPath();
  context.moveTo(bounds.left + width * 0.25, bounds.top);
  context.lineTo(bounds.left + width * 0.41, bounds.top + height * 0.4);
  context.lineTo(bounds.left + width * 0.3, bounds.bottom);
  context.moveTo(bounds.left + width * 0.7, bounds.top);
  context.lineTo(bounds.left + width * 0.58, bounds.top + height * 0.55);
  context.lineTo(bounds.left + width * 0.8, bounds.bottom);
  context.stroke();
}

function drawMetal(context, bounds) {
  const height = bounds.bottom - bounds.top;
  context.strokeStyle = 'rgba(255,255,255,.34)';
  context.lineWidth = 0.025;
  for (let y = bounds.top + height * 0.15; y < bounds.bottom; y += Math.max(0.1, height * 0.2)) {
    context.beginPath();
    context.moveTo(bounds.left, y);
    context.lineTo(bounds.right, y);
    context.stroke();
  }
  context.strokeStyle = 'rgba(226,239,255,.68)';
  context.lineWidth = 0.04;
  context.beginPath();
  context.moveTo(bounds.left, bounds.top + 0.02);
  context.lineTo(bounds.right, bounds.top + 0.02);
  context.moveTo(bounds.left + 0.02, bounds.top);
  context.lineTo(bounds.left + 0.02, bounds.bottom);
  context.stroke();
}

function drawRubber(context, bounds) {
  const gradient = context.createLinearGradient(bounds.left, bounds.top, bounds.right, bounds.bottom);
  gradient.addColorStop(0, 'rgba(255,255,255,.26)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  const inset = Math.min(bounds.right - bounds.left, bounds.bottom - bounds.top) * 0.04;
  context.strokeStyle = 'rgba(41,26,58,.58)';
  context.lineWidth = 0.045;
  context.strokeRect(
    bounds.left + inset,
    bounds.top + inset,
    bounds.right - bounds.left - inset * 2,
    bounds.bottom - bounds.top - inset * 2,
  );
}

export function loadMaterialAssets(document) {
  return loadOriginalFormalAssets(document);
}

function drawExplosiveBarrel(context) {
  // 实心爆炸桶：外层已用桶色填充，这里叠加桶缘、警示带、金属箍与高光，坐标适配 0.5m 方桶。
  context.strokeStyle = 'rgba(70,20,14,.85)';
  context.lineWidth = 0.05;
  context.strokeRect(-0.22, -0.22, 0.44, 0.44);
  context.fillStyle = '#F2B134';
  context.fillRect(-0.235, -0.1, 0.47, 0.2);
  context.fillStyle = 'rgba(80,24,16,.9)';
  context.fillRect(-0.235, -0.03, 0.47, 0.06);
  context.strokeStyle = 'rgba(70,20,14,.75)';
  context.lineWidth = 0.035;
  context.beginPath();
  context.moveTo(-0.235, -0.155);
  context.lineTo(0.235, -0.155);
  context.moveTo(-0.235, 0.155);
  context.lineTo(0.235, 0.155);
  context.stroke();
  context.fillStyle = 'rgba(255,255,255,.22)';
  context.fillRect(-0.18, -0.235, 0.055, 0.47);
}

export function drawMaterialSurface(context, {
  shape, shapePresetId, materialId, color, hollow = false,
  hollowBorder, hp, maxHp, specialType, formalAssetDrawer = drawOriginalFormalAsset,
}) {
  const bounds = shapeBounds(shape);
  if (shapePresetId && materialId && formalAssetDrawer({
    context,
    shapePresetId,
    materialId,
    hp,
    maxHp,
    targetWidth: bounds.right - bounds.left,
    targetHeight: bounds.bottom - bounds.top,
    specialType,
  })) return 'formal';
  context.save();
  traceShape(context, shape);
  if (hollow && shape.kind === 'box' && !specialType) {
    const border = Number.isFinite(hollowBorder) && hollowBorder > 0
      ? Math.min(hollowBorder, Math.min(shape.width, shape.height) / 2)
      : Math.min(shape.width, shape.height) * 0.22;
    context.rect(
      bounds.left + border,
      bounds.top + border,
      bounds.right - bounds.left - border * 2,
      bounds.bottom - bounds.top - border * 2,
    );
    context.clip('evenodd');
  } else context.clip();
  if (materialId !== 'glass') {
    context.fillStyle = color || '#738096';
    context.fill();
  }

  if (specialType === 'explosive-barrel') drawExplosiveBarrel(context);
  else if (materialId === 'wood') drawWood(context, bounds);
  else if (materialId === 'glass') drawGlass(context, bounds, color);
  else if (materialId === 'stone') drawStone(context, bounds);
  else if (materialId === 'metal') drawMetal(context, bounds);
  else if (materialId === 'rubber') drawRubber(context, bounds);

  context.restore();
  return 'procedural';
}
import {
  drawOriginalFormalAsset,
  loadOriginalFormalAssets,
} from '../vendor/meteor-original-runtime.js';
