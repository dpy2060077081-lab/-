/** Pure Meteor Castle level rules and Canvas rendering helpers. */

import { drawMaterialSurface, traceShape } from './static/js/material-renderer.js';
import { validateFrozenBodies } from './static/js/frozen-body-model.js';
import { drawFrozenBodyOverlay } from './static/js/frozen-body-renderer.js';
export { assetEntries as listAssets } from './static/js/asset-store.js';

const ORIGINAL_PIXELS_PER_METER = 40;
const ORIGINAL_CANVAS_WIDTH = 360;
const ORIGINAL_LAUNCHER = Object.freeze({ x: 4.5, y: 0.45 });
const ORIGINAL_BARREL_LENGTH = 0.65;

const SHAPE_KINDS = new Set(["box", "circle", "polygon"]);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finitePositive = value => Number.isFinite(value) && value > 0;
const OBJECT_NUMBER_RULES = Object.freeze({
  mass: value => finitePositive(value),
  friction: value => Number.isFinite(value) && value >= 0 && value <= 1,
  restitution: value => Number.isFinite(value) && value >= 0 && value <= 1,
  maxHp: value => finitePositive(value),
  hitSpeedThreshold: value => Number.isFinite(value) && value >= 0,
});

export function createEmptyLevel({ id, levelId = `level-${id}`, levelName = `新关卡 ${id}` }) {
  return {
    levelNumber: Number(id),
    levelName,
    difficulty: "normal",
    description: "自定义空白关卡",
    normalAmmo: 15,
    explosiveAmmo: 1,
    splitAmmo: 0,
    blackHoleAmmo: 0,
    platformType: "single-3",
    castle: [],
    __levelDocument: { version: 2, type: "level", levelId, rootExtensions: {} },
  };
}

function polygonIsValid(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) return false;
  let direction = 0;
  let area = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    const c = vertices[(index + 2) % vertices.length];
    if (![a, b, c].every(point => isRecord(point) && Number.isFinite(point.x) && Number.isFinite(point.y))) return false;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return false;
    area += a.x * b.y - b.x * a.y;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (direction && Math.sign(cross) !== direction) return false;
    direction = Math.sign(cross);
  }
  return direction !== 0 && Math.abs(area) > 1e-9;
}

function shapeIsValid(shape) {
  if (!isRecord(shape) || !SHAPE_KINDS.has(shape.kind)) return false;
  if (shape.kind === "box") return finitePositive(shape.width) && finitePositive(shape.height);
  if (shape.kind === "circle") return finitePositive(shape.radius);
  return polygonIsValid(shape.vertices);
}

function validateLevelWithBoltPolicy(level, assets, { allowFalseBolt }) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!isRecord(level)) return { ok: false, errors: [{ path: "", message: "关卡必须是对象" }] };
  for (const section of ["objectProfiles", "global", "meteor", "explosive", "launcher", "environment"]) {
    if (level[section] !== undefined && !isRecord(level[section])) add(section, `${section} 必须是对象`);
  }
  if (!Array.isArray(level.castle)) add("castle", "castle 必须是数组");
  if (errors.length) return { ok: false, errors };

  const knownMaterials = new Set(Object.keys(assets.materials || {}));
  const knownShapes = new Set(Object.keys(assets.shapes || {}));
  const knownSpecials = new Set(Object.keys(assets.specialObjects || {}));
  const ids = new Set();
  for (let index = 0; index < level.castle.length; index += 1) {
    const object = level.castle[index];
    if (!isRecord(object)) { add(`castle.${index}`, "物件必须是对象"); continue; }
    const base = typeof object.id === "string" && object.id ? `castle.${object.id}` : `castle.${index}`;
    if (typeof object.id !== "string" || !object.id) add(`${base}.id`, "ID 不能为空");
    else if (ids.has(object.id)) add(`${base}.id`, "ID 必须唯一");
    else ids.add(object.id);
    if (!Number.isFinite(object.x)) add(`${base}.x`, "x 必须是数字");
    if (!Number.isFinite(object.y)) add(`${base}.y`, "y 必须是数字");
    if (!Number.isFinite(object.angle)) add(`${base}.angle`, "angle 必须是数字");
    const resolvedShape = object.shape ?? assets.shapes?.[object.shapePresetId]?.shape;
    if (!shapeIsValid(resolvedShape)) add(`${base}.shape`, "形状无效");
    if (object.shape?.cornerRadius !== undefined && (!Number.isFinite(object.shape.cornerRadius) || object.shape.cornerRadius < 0)) {
      add(`${base}.shape.cornerRadius`, "圆角必须是非负数字");
    }
    if (object.shape?.kind === "box" && Number.isFinite(object.shape.cornerRadius)
      && object.shape.cornerRadius > Math.min(object.shape.width, object.shape.height) / 2) {
      add(`${base}.shape.cornerRadius`, "圆角不能超过短边的一半");
    }
    for (const [field, accepts] of Object.entries(OBJECT_NUMBER_RULES)) {
      if (Object.hasOwn(object, field) && !accepts(object[field])) add(`${base}.${field}`, `${field} 数值超出有效范围`);
    }
    if (object.materialId !== undefined && knownMaterials.size && !knownMaterials.has(object.materialId)) add(`${base}.materialId`, "未知材质");
    if (object.shapePresetId !== undefined && knownShapes.size && !knownShapes.has(object.shapePresetId)) add(`${base}.shapePresetId`, "未知形状预设");
    if (object.specialType !== undefined && knownSpecials.size && !knownSpecials.has(object.specialType)) add(`${base}.specialType`, "未知特殊物件");
    if (object.fixedBolt !== undefined && object.fixedBolt !== true && !(allowFalseBolt && object.fixedBolt === false)) {
      add(`${base}.fixedBolt`, "固定螺栓只能为 true 或省略");
    } else if (object.fixedBolt === true) {
      const material = assets.materials?.[object.materialId];
      const special = assets.specialObjects?.[object.specialType];
      const destructible = object.destructible ?? special?.destructible ?? material?.destructible;
      if (object.specialType || !destructible || !["wood", "glass"].includes(object.materialId)) {
        add(`${base}.fixedBolt`, "固定螺栓只能安装在可破坏的木材或玻璃普通物件上");
      }
    }
  }
  const frozen = validateFrozenBodies(level, assets);
  errors.push(...frozen.errors);
  return { ok: errors.length === 0, errors };
}

/** Validate authored v2 levels without normalizing, cloning, or removing extension fields. */
export function validateLevel(level, assets = {}) {
  return validateLevelWithBoltPolicy(level, assets, { allowFalseBolt: false });
}

/** Validate immutable legacy/runtime input where false explicitly disables an inherited bolt. */
export function validateLegacyRuntimeLevel(level, assets = {}) {
  return validateLevelWithBoltPolicy(level, assets, { allowFalseBolt: true });
}

export function getAssetReferences(level, assetId) {
  return (level.castle || []).some(object => [object.materialId, object.shapePresetId, object.specialType].includes(assetId));
}

export function getBoardLayout(level, canvas, config = {}) {
  const canvasWidth = Number(config.canvas?.width);
  const canvasHeight = Number(config.canvas?.height);
  if (!finitePositive(canvasWidth) || !finitePositive(canvasHeight)) {
    throw new RangeError("config.canvas.width 和 config.canvas.height 必须是正数");
  }
  const worldWidth = Number(config.world?.width);
  const worldHeight = Number(config.world?.height);
  if (!finitePositive(worldWidth) || !finitePositive(worldHeight)) {
    throw new RangeError("config.world.width 和 config.world.height 必须是正数");
  }
  const scale = Math.min(canvasWidth / worldWidth, canvasHeight / worldHeight);
  const width = worldWidth * scale;
  const height = worldHeight * scale;
  return { canvasWidth, canvasHeight, worldWidth, worldHeight, scale, width, height, left: (canvasWidth - width) / 2, top: (canvasHeight - height) / 2 };
}

/** Kept under the template interface name; returns a free-world point, not a grid cell. */
export function canvasPointToCell(x, y, layout) {
  if (x < layout.left || y < layout.top || x > layout.left + layout.width || y > layout.top + layout.height) return null;
  const worldX = Math.abs(x - layout.left - layout.width) < 1e-9 ? layout.worldWidth : (x - layout.left) / layout.scale;
  const worldY = Math.abs(y - layout.top - layout.height) < 1e-9 ? layout.worldHeight : (y - layout.top) / layout.scale;
  return {
    x: Math.max(0, Math.min(layout.worldWidth, worldX)),
    y: Math.max(0, Math.min(layout.worldHeight, worldY)),
  };
}

function drawFixedBolt(context) {
  context.save();
  for (const x of [-12 / ORIGINAL_PIXELS_PER_METER, 12 / ORIGINAL_PIXELS_PER_METER]) {
    context.fillStyle = "#dfe7ec";
    context.strokeStyle = "#34495e";
    context.lineWidth = 2 / ORIGINAL_PIXELS_PER_METER;
    context.beginPath();
    context.arc(x, 0, 5 / ORIGINAL_PIXELS_PER_METER, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.beginPath();
    context.moveTo(x - 3 / ORIGINAL_PIXELS_PER_METER, 0);
    context.lineTo(x + 3 / ORIGINAL_PIXELS_PER_METER, 0);
    context.moveTo(x, -3 / ORIGINAL_PIXELS_PER_METER);
    context.lineTo(x, 3 / ORIGINAL_PIXELS_PER_METER);
    context.stroke();
  }
  context.restore();
}

export function drawPlayCannon(context, launcherAngleDegrees = 0) {
  const angle = Number.isFinite(launcherAngleDegrees) ? launcherAngleDegrees : 0;
  context.save();
  context.translate(ORIGINAL_LAUNCHER.x, ORIGINAL_LAUNCHER.y);
  context.rotate(-angle * Math.PI / 180);
  context.fillStyle = "#34495e";
  context.fillRect(-7 / ORIGINAL_PIXELS_PER_METER, -4 / ORIGINAL_PIXELS_PER_METER, 14 / ORIGINAL_PIXELS_PER_METER, ORIGINAL_BARREL_LENGTH + 7 / ORIGINAL_PIXELS_PER_METER);
  context.fillStyle = "#172635";
  context.fillRect(-10 / ORIGINAL_PIXELS_PER_METER, ORIGINAL_BARREL_LENGTH - 2 / ORIGINAL_PIXELS_PER_METER, 20 / ORIGINAL_PIXELS_PER_METER, 8 / ORIGINAL_PIXELS_PER_METER);
  context.restore();
  context.save();
  context.fillStyle = "#c59b55";
  context.fillRect(ORIGINAL_LAUNCHER.x - 13 / ORIGINAL_PIXELS_PER_METER, ORIGINAL_LAUNCHER.y - 13 / ORIGINAL_PIXELS_PER_METER, 26 / ORIGINAL_PIXELS_PER_METER, 26 / ORIGINAL_PIXELS_PER_METER);
  context.strokeStyle = "#172635";
  context.lineWidth = 1 / ORIGINAL_PIXELS_PER_METER;
  context.strokeRect(ORIGINAL_LAUNCHER.x - 13 / ORIGINAL_PIXELS_PER_METER, ORIGINAL_LAUNCHER.y - 13 / ORIGINAL_PIXELS_PER_METER, 26 / ORIGINAL_PIXELS_PER_METER, 26 / ORIGINAL_PIXELS_PER_METER);
  context.restore();
}

export function drawPlayProjectile(context, projectile) {
  const x = Number(projectile.position?.x ?? projectile.x ?? 0);
  const y = Number(projectile.position?.y ?? projectile.y ?? 0);
  const radius = Number(projectile.radius ?? projectile.shape?.radius ?? 0.2);
  context.save();
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  const colors = { explosive: "#d93855", split: "#25aebe", splitChild: "#62dce8", blackHole: "#7b4ce2" };
  context.fillStyle = colors[projectile.meteorType] ?? "#ff654f";
  context.fill();
  context.strokeStyle = "#34495e";
  context.lineWidth = 1 / ORIGINAL_PIXELS_PER_METER;
  context.stroke();
  context.restore();
}

export function drawSpecialProjectileEffects(context, simulation) {
  for (const effect of simulation?.specialEffects ?? []) {
    const alpha = Math.max(0, Math.min(1, Number(effect.remainingMs) / 260));
    context.save();
    context.translate(effect.position.x, effect.position.y);
    context.strokeStyle = `rgba(255,245,170,${alpha})`;
    context.lineWidth = 3 / ORIGINAL_PIXELS_PER_METER;
    for (let index = 0; index < 8; index += 1) {
      const angle = index * Math.PI / 4;
      context.beginPath();
      context.moveTo(Math.cos(angle) * 0.12, Math.sin(angle) * 0.12);
      context.lineTo(Math.cos(angle) * 0.5, Math.sin(angle) * 0.5);
      context.stroke();
    }
    context.restore();
  }
  for (const blackHole of simulation?.blackHoles ?? []) {
    const consumeRadius = Number(simulation?.blackHoleConfig?.consumeRadius ?? 0.65);
    context.save();
    context.translate(blackHole.position.x, blackHole.position.y);
    context.rotate(Number(blackHole.ageMs ?? 0) / 260);
    context.lineWidth = 5 / ORIGINAL_PIXELS_PER_METER;
    context.strokeStyle = "#a875ff";
    context.beginPath();
    context.arc(0, 0, consumeRadius * 1.18, 0.25, Math.PI * 1.72);
    context.stroke();
    context.rotate(Math.PI);
    context.strokeStyle = "#5924a8";
    context.beginPath();
    context.arc(0, 0, consumeRadius * 0.9, 0.15, Math.PI * 1.65);
    context.stroke();
    context.fillStyle = "#09040f";
    context.beginPath();
    context.arc(0, 0, consumeRadius * 0.56, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

export function drawPlayHud(context, snapshot, { canvasWidth = context.canvas?.width ?? ORIGINAL_CANVAS_WIDTH } = {}) {
  const scale = canvasWidth / ORIGINAL_CANVAS_WIDTH;
  context.save();
  context.scale(scale, scale);
  context.fillStyle = "rgba(244, 248, 251, 0.9)";
  context.fillRect(8, 8, ORIGINAL_CANVAS_WIDTH - 16, 30);
  context.fillStyle = "#29364a";
  context.font = "700 16px ui-monospace, monospace";
  context.textAlign = "left";
  context.fillText(`普通炮弹 ${snapshot.normalAmmo}`, 16, 29);
  context.textAlign = "center";
  context.font = "700 10px ui-monospace, monospace";
  context.fillText(String(snapshot.phase ?? "").toUpperCase(), ORIGINAL_CANVAS_WIDTH / 2, 27);
  context.textAlign = "right";
  context.font = "700 16px ui-monospace, monospace";
  context.fillText(`TARGET ${snapshot.remainingTargets}`, ORIGINAL_CANVAS_WIDTH - 16, 29);
  context.restore();
}

function drawPlayProjectileWalls(context) {
  context.save();
  context.strokeStyle = "#ffe600";
  context.lineWidth = 6 / ORIGINAL_PIXELS_PER_METER;
  for (const x of [0, 9]) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, 12.66);
    context.stroke();
  }
  context.restore();
}

function placementPlatforms(environment = {}) {
  if (environment.platformType === "single-3") return [{ centerX: 4.5, width: 3 }];
  if (environment.platformType === "single-5") return [{ centerX: 4.5, width: 5 }];
  if (["double-2", "double-3"].includes(environment.platformType)) {
    const width = environment.platformType === "double-2" ? 2 : 3;
    const offset = 0.4 + width / 2;
    return [{ centerX: 4.5 - offset, width }, { centerX: 4.5 + offset, width }];
  }
  const width = Number(environment.baseWidth);
  return finitePositive(width) ? [{ centerX: 4.5, width }] : [];
}

function placementHillPaths(platforms) {
  if (platforms.length === 1) {
    return [[{ x: 0, y: 16 }, { x: 4.5, y: 12.85 }, { x: 9, y: 16 }]];
  }
  return platforms.map(({ centerX, width }) => {
    const half = width / 2;
    const points = [{ x: centerX - half, y: 16 }, { x: centerX - half, y: 14 }];
    for (let step = 1; step <= 8; step += 1) {
      const angle = Math.PI * (1 - step / 8);
      points.push({
        x: step === 4 ? centerX : centerX + half * Math.cos(angle),
        y: step === 4 ? 12.85 : 14 - (14 - 12.85) * Math.sin(angle),
      });
    }
    points.push({ x: centerX + half, y: 16 });
    return points;
  });
}

function drawEnvironment(context, environment = {}, visibleBottom = 16) {
  const platforms = placementPlatforms(environment);
  if (!platforms.length) return;
  context.fillStyle = "#f04444";
  for (const { centerX, width } of platforms) context.fillRect(centerX - width / 2, 12.34, width, 0.32);
  const hillPaths = placementHillPaths(platforms);
  context.fillStyle = "#263b52";
  for (const points of hillPaths) {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.lineTo(points.at(-1).x, visibleBottom);
    context.lineTo(points[0].x, visibleBottom);
    context.closePath();
    context.fill();
  }
  context.beginPath();
  for (const points of hillPaths) {
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  }
  context.lineWidth = 0.08;
  context.strokeStyle = "#c8d3df";
  context.stroke();
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(0, 12.66);
  context.moveTo(9, 0);
  context.lineTo(9, 12.66);
  context.lineWidth = 0.06;
  context.strokeStyle = "#8ba3b8";
  context.stroke();
}

export function drawLevel(context, level, {
  mode = "preview", config = {}, assets = {}, selection = [], preview = [], alignmentGuides = [], viewport = {}, formalAssetDrawer, simulation,
} = {}) {
  const layout = getBoardLayout(level, context.canvas, config);
  const zoom = Number(viewport.zoom || 1);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.fillStyle = "#172640";
  context.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);
  context.save();
  const viewportX = Number(viewport.x || 0);
  const viewportY = Number(viewport.y || 0);
  context.translate(layout.left + viewportX, layout.top + viewportY);
  context.scale(layout.scale * zoom, layout.scale * zoom);
  const visibleBottom = Math.max(16, (layout.canvasHeight - layout.top - viewportY) / (layout.scale * zoom));
  drawEnvironment(context, { ...(config.runtime?.environment || level.environment), platformType: level.environment?.platformType ?? level.platformType ?? config.runtime?.environment?.platformType }, visibleBottom);
  if (mode === "play") {
    drawPlayProjectileWalls(context);
    drawPlayCannon(context, simulation?.launcherAngleDegrees);
  }
  for (const object of level.castle || []) {
    const shape = object.shape ?? assets.shapes?.[object.shapePresetId]?.shape;
    context.save();
    if (preview.includes(object.id)) context.globalAlpha = 0.55;
    context.translate(object.x, object.y);
    context.rotate(Number(object.angle || 0));
    const color = object.color
      || assets.specialObjects?.[object.specialType]?.color
      || assets.materials?.[object.materialId]?.color
      || "#738096";
    drawMaterialSurface(context, {
      shape,
      shapePresetId: object.shapePresetId,
      materialId: object.materialId,
      color,
      hollow: assets.shapes?.[object.shapePresetId]?.hollow === true && !object.specialType,
      hp: object.hp,
      maxHp: object.maxHp,
      specialType: object.specialType,
      ...(formalAssetDrawer ? { formalAssetDrawer } : {}),
      hollowBorder: assets.shapes?.[object.shapePresetId]?.hollowBorder,
    });
    if (object.fixedBolt === true) drawFixedBolt(context);
    if (selection.includes(object.id)) {
      traceShape(context, shape);
      context.lineWidth = 2 / (layout.scale * zoom);
      context.strokeStyle = "#ffffff";
      context.stroke();
    }
    context.restore();
  }
  const frozenBodies = mode === "play" ? simulation?.frozenBodies : level.frozenBodies;
  for (const group of frozenBodies || []) {
    drawFrozenBodyOverlay(context, {
      group,
      members: level.castle || [],
      state: mode === "play" ? group.state : "intact",
      hitPoint: mode === "play" ? group.hitPoint : null,
      assets,
    });
  }
  if (alignmentGuides.length) {
    context.save();
    context.strokeStyle = "#38d8ff";
    context.lineWidth = 2 / (layout.scale * zoom);
    context.setLineDash([8 / (layout.scale * zoom), 5 / (layout.scale * zoom)]);
    context.beginPath();
    for (const guide of alignmentGuides) {
      if (guide.axis === "x") {
        context.moveTo(guide.value, guide.start);
        context.lineTo(guide.value, guide.end);
      } else if (guide.axis === "y") {
        context.moveTo(guide.start, guide.value);
        context.lineTo(guide.end, guide.value);
      }
    }
    context.stroke();
    context.restore();
  }
  if (mode === "play") {
    for (const projectile of simulation?.projectiles || []) drawPlayProjectile(context, projectile);
    drawSpecialProjectileEffects(context, simulation);
  }
  context.restore();
  if (mode === "play" && simulation) drawPlayHud(context, simulation, { canvasWidth: layout.canvasWidth });
  else {
    context.fillStyle = "#fff";
    context.font = `700 ${Math.max(12, layout.canvasWidth * 0.035)}px sans-serif`;
    context.textAlign = "center";
    context.fillText(level.levelName || "陨石城堡", layout.canvasWidth / 2, Math.max(24, layout.top * 0.55));
    context.font = `${Math.max(10, layout.canvasWidth * 0.018)}px sans-serif`;
    context.fillStyle = "#aebbd0";
    context.fillText("自由坐标预览", layout.canvasWidth / 2, Math.max(42, layout.top * 0.78));
  }
}

export function calculateDifficulty(level) {
  const objects = level.castle || [];
  const destructible = objects.filter(object => object.destructible).length;
  const materials = new Set(objects.map(object => object.materialId).filter(Boolean));
  const specials = objects.filter(object => object.specialType).length;
  const factors = {
    objectCount: Math.min(100, Math.round(objects.length / 30 * 100)),
    destructibility: Math.min(100, Math.round(destructible / Math.max(1, objects.length) * 100)),
    variety: Math.min(100, Math.round((materials.size + specials) / 8 * 100)),
  };
  const score = Math.round(factors.objectCount * 0.45 + factors.destructibility * 0.3 + factors.variety * 0.25);
  return { score, level: score < 30 ? "简单" : score < 55 ? "普通" : score < 75 ? "困难" : "专家", factors };
}

export function getEndActions(result, hasNext) {
  return { retry: true, next: result === "won" && Boolean(hasNext) };
}

/** Demo play-result policy; a real runtime may replace this with simulation output. */
export function getPlayResult(level) {
  return Array.isArray(level?.castle) ? "won" : "lost";
}
