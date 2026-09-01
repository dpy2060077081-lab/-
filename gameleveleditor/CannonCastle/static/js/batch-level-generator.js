import { validateLevel } from '../../gamelogic.js';
import { exportedLevelFilename } from '../../levellist.js';
import { environmentSupports, objectBounds, placementConstants, shapesOverlap } from './placement-collision.js';
import { compareStructureDescriptors, isNearDuplicate, macroCategoryLabel, reconstructLevelStructure, structureSignature } from './level-structure.js';

const clone = value => structuredClone(value);
const PLATFORMS = Object.freeze(['single-3', 'single-5', 'double-2', 'double-3']);
const MIN_OBJECTS = 70;
const MAX_OBJECTS = 100;
const MAX_REWRITES = 28;
const MATERIAL_MINIMUMS = Object.freeze({ wood: 18, glass: 7, stone: 6, metal: 3, rubber: 2 });
const SUPPORT_EMBED = -0.01;
export const MAX_DIRECT_SUPPORT_EMBED = placementConstants.SUPPORT_MAX_EMBED;
const LOCAL_RETRY_OFFSETS = Object.freeze([307, 613, 919]);
const BASE_PROFILES = Object.freeze([
  Object.freeze({ id: 'single-plinth', branchOffset: 0.48, segmentOffset: 1.25, raised: false, singleShelf: true, connectionShift: 0 }),
  Object.freeze({ id: 'close-buttress', branchOffset: 0.5, segmentOffset: 1.25, raised: false, singleShelf: false, connectionShift: -1 }),
  Object.freeze({ id: 'wide-buttress', branchOffset: 0.6, segmentOffset: 1.25, raised: false, singleShelf: false, connectionShift: 0 }),
  Object.freeze({ id: 'raised-plinth', branchOffset: 0.5, segmentOffset: 1.25, raised: true, singleShelf: true, connectionShift: 0 }),
  Object.freeze({ id: 'raised-buttress', branchOffset: 0.64, segmentOffset: 1.25, raised: true, singleShelf: false, connectionShift: -1 }),
]);
export const MACRO_FAMILIES = Object.freeze({
  'stepped-keep': Object.freeze({
    label: '退台城堡', initialTwin: false, keepTwinTop: false, forbiddenOperations: Object.freeze(['wing']),
    stages: Object.freeze([
      { spanCount: 2, widthRatio: 0.94, centerOffset: 0.00, centerVoid: false },
      { spanCount: 2, widthRatio: 0.78, centerOffset: 0.00, centerVoid: false },
      { spanCount: 1, widthRatio: 0.58, centerOffset: 0.00, centerVoid: false },
      { spanCount: 1, widthRatio: 0.36, centerOffset: 0.00, centerVoid: false },
    ]),
  }),
  gatehouse: Object.freeze({
    label: '双塔门楼', initialTwin: true, keepTwinTop: false, forbiddenOperations: Object.freeze(['wing']),
    stages: Object.freeze([
      { spanCount: 2, widthRatio: 0.86, centerOffset: 0.00, centerVoid: true },
      { spanCount: 2, widthRatio: 0.82, centerOffset: 0.00, centerVoid: true },
      { spanCount: 1, widthRatio: 0.62, centerOffset: 0.00, centerVoid: false },
      { spanCount: 1, widthRatio: 0.46, centerOffset: 0.00, centerVoid: false },
    ]),
  }),
  'asymmetric-keep': Object.freeze({
    label: '偏心主塔', initialTwin: false, keepTwinTop: false, forbiddenOperations: Object.freeze([]),
    stages: Object.freeze([
      { spanCount: 2, widthRatio: 0.92, centerOffset: 0.00, centerVoid: false },
      { spanCount: 2, widthRatio: 0.76, centerOffset: 0.12, centerVoid: false },
      { spanCount: 1, widthRatio: 0.56, centerOffset: 0.23, centerVoid: false },
      { spanCount: 1, widthRatio: 0.38, centerOffset: 0.30, centerVoid: false },
    ]),
  }),
  'central-hall': Object.freeze({
    label: '中央高殿', initialTwin: true, keepTwinTop: false, forbiddenOperations: Object.freeze(['wing']),
    stages: Object.freeze([
      { spanCount: 2, widthRatio: 0.94, centerOffset: 0.00, centerVoid: false },
      { spanCount: 2, widthRatio: 0.88, centerOffset: 0.00, centerVoid: false },
      { spanCount: 1, widthRatio: 0.74, centerOffset: 0.00, centerVoid: false },
      { spanCount: 1, widthRatio: 0.60, centerOffset: 0.00, centerVoid: false },
    ]),
  }),
  'bridge-fortress': Object.freeze({
    label: '高桥双堡', initialTwin: true, keepTwinTop: true, forbiddenOperations: Object.freeze(['merge', 'wing']),
    stages: Object.freeze([
      { spanCount: 2, widthRatio: 0.90, centerOffset: 0.00, centerVoid: true },
      { spanCount: 2, widthRatio: 0.88, centerOffset: 0.00, centerVoid: true },
      { spanCount: 2, widthRatio: 0.84, centerOffset: 0.00, centerVoid: false },
      { spanCount: 2, widthRatio: 0.72, centerOffset: 0.00, centerVoid: true },
    ]),
  }),
  'zigzag-terrace': Object.freeze({
    label: '错位阶堡', initialTwin: false, keepTwinTop: false, forbiddenOperations: Object.freeze([]),
    stages: Object.freeze([
      { spanCount: 2, widthRatio: 0.92, centerOffset: 0.00, centerVoid: false },
      { spanCount: 2, widthRatio: 0.80, centerOffset: 0.16, centerVoid: false },
      { spanCount: 2, widthRatio: 0.68, centerOffset: -0.16, centerVoid: false },
      { spanCount: 1, widthRatio: 0.46, centerOffset: 0.24, centerVoid: false },
    ]),
  }),
});
export const MACRO_FAMILY_KEYS = Object.freeze(Object.keys(MACRO_FAMILIES));
export const GENERATOR_VERSION = 3;
export const REJECTION_LABELS = Object.freeze({
  bounds: '静态越界', overlap: '形状重叠', support: '支撑链断开', material: '材质数量或比例不满足',
  complexity: '复杂度、开口或占用率不满足', duplicate: '与现有关卡或当前批次重复',
  missing: '物件丢失', damage: '物件掉血', unstableBounds: '物理越界', displacement: '位移超出稳定容差',
  angle: '角度超出稳定容差', timeout: '8 秒内无法静止', diversity: '批次结构类别配额不满足',
  cancelled: '已取消', attempts: '达到尝试上限', performance: '达到性能时间上限', runtime: '正式运行时错误',
});
const REWRITE_CATEGORIES = Object.freeze({
  split: 'topology', merge: 'topology', cross: 'connection', opening: 'opening',
  step: 'contour', wing: 'contour', narrow: 'contour', truncate: 'termination', brace: 'stability', foot: 'stability',
});

function hashSeed(value, version = GENERATOR_VERSION) {
  let hash = 2166136261;
  for (const character of `${version}:${value}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 0x9e3779b9;
}

export function createDeterministicRandom(seed, version = GENERATOR_VERSION) {
  let state = hashSeed(seed, version);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shapeObject(assets, id, number, sequence, x, y, angle, role) {
  const asset = assets.shapes?.[id];
  if (!asset?.shape) throw Object.assign(new Error(`缺少形状资源：${id}`), { code: 'CONFIG_INVALID' });
  return {
    object: { id: `generated-${number}-${String(sequence).padStart(3, '0')}`, name: asset.name ?? id, x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), angle, shapePresetId: id, materialId: 'glass', shape: clone(asset.shape) },
    role,
  };
}

function assignMaterials(entries, supports) {
  const count = entries.length;
  const woodTarget = Math.max(MATERIAL_MINIMUMS.wood, Math.round(count * 0.25));
  const metalTarget = Math.ceil(count * 0.2);
  const stoneTarget = Math.ceil(count * 0.6) - metalTarget;
  const glassTarget = Math.floor(count * 0.1);
  const foundations = entries.filter(entry => entry.role === 'foundation');
  const parentIds = new Set([...supports.values()].flat().map(parent => parent.id));
  const soleParentIds = new Set([...supports.values()].filter(parents => parents.length === 1).map(parents => parents[0].id));
  const terminals = entries.filter(entry => !parentIds.has(entry.object.id));
  const centeredFoundations = foundations.filter(entry => !soleParentIds.has(entry.object.id)).sort((left, right) => {
    const score = entry => Math.min(Infinity, ...entries.filter(child => supports.get(child.object.id)?.some(parent => parent.id === entry.object.id)).map(child => Math.abs(child.object.x - entry.object.x)));
    return score(left) - score(right) || left.object.x - right.object.x;
  });
  const rubber = [...terminals, ...centeredFoundations, ...entries.filter(entry => !soleParentIds.has(entry.object.id))]
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .slice(0, 2);
  if (rubber.length < 2) throw new Error('结构无法满足橡胶职责');
  rubber.forEach(entry => { entry.object.materialId = 'rubber'; });
  const platformRoots = foundations.filter(entry => !supports.get(entry.object.id)?.length && !rubber.includes(entry));
  platformRoots.forEach(entry => { entry.object.materialId = 'stone'; });
  const reinforced = entries.filter(entry => !rubber.includes(entry) && !platformRoots.includes(entry))
    .sort((left, right) => right.object.y - left.object.y || left.object.x - right.object.x);
  reinforced.slice(0, metalTarget).forEach(entry => { entry.object.materialId = 'metal'; });
  reinforced.slice(metalTarget, metalTarget + Math.max(0, stoneTarget - platformRoots.length)).forEach(entry => { entry.object.materialId = 'stone'; });
  const remaining = entries.filter(entry => entry.object.materialId === 'glass')
    .sort((left, right) => left.object.y - right.object.y || left.object.x - right.object.x);
  remaining.slice(glassTarget, glassTarget + woodTarget).forEach(entry => { entry.object.materialId = 'wood'; });
  remaining.slice(glassTarget + woodTarget).forEach(entry => { entry.object.materialId = 'stone'; });
}

const shelfShape = width => width > 1.2 ? 'long-thin-rectangle' : 'short-thin-rectangle';
const shelfWidth = shape => shape === 'long-thin-rectangle' ? 2.2 : 0.9;
const cohesionReach = (left, right) => 1.4 + (left.width + right.width) / 2;
const cohesionBridgeX = (left, right) => (
  left.x + left.width / 2 - 0.14 + right.x - right.width / 2 + 0.14
) / 2;

function planKey(plan) { return plan.map(shelf => `${shelf.x.toFixed(2)}:${shelf.width}`).join('|'); }

function nextPlans(current, random, layer, exploration, rarityWeights, baseProfile) {
  const ordered = [...current].sort((left, right) => left.x - right.x);
  const center = (ordered[0].x + ordered.at(-1).x) / 2;
  const wingOffset = rarityWeights?.compactWing
    ? (new Set(current.flatMap(value => [...value.regions])).size > 1 && current.length <= 4 ? 0.15 : 0) : 0.15;
  const openingShifts = ordered.map(() => (Math.floor(random() * 5) - 2) * 0.09);
  const carry = operation => ordered.map((shelf, index) => ({
    x: shelf.x + Number(operation === 'opening') * Math.sign(shelf.x - center) * openingShifts[index],
    width: shelf.width,
    operation,
  }));
  const carryOperation = ordered.length > 1 ? 'opening' : 'brace';
  const plans = [carry(carryOperation)];
  if (carryOperation === 'opening' && openingShifts.some(Boolean)) plans.push(ordered.map(shelf => ({ ...shelf, operation: 'opening' })));
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index]; const right = ordered[index + 1];
    const joinsCohesion = left.cohesion && right.cohesion && ![...left.cohesion].some(value => right.cohesion.has(value));
    if (joinsCohesion && right.x - left.x <= cohesionReach(left, right)) {
      plans.push([...ordered.slice(0, index).map(shelf => ({ ...shelf, operation: 'hold' })),
        { x: cohesionBridgeX(left, right), width: 2.2, operation: 'cross' },
        ...ordered.slice(index + 2).map(shelf => ({ ...shelf, operation: 'hold' }))]);
    }
    if (left.width <= 1.2 && right.width <= 1.2 && right.x - left.x > 1.35 && right.x - left.x <= 2) {
      plans.push([...ordered.slice(0, index).map(shelf => ({ ...shelf, operation: 'brace' })),
        { x: (left.x + right.x) / 2, width: 2.2, operation: 'merge' },
        ...ordered.slice(index + 2).map(shelf => ({ ...shelf, operation: 'brace' }))]);
      plans.push([...ordered.slice(0, index).map(shelf => ({ ...shelf, operation: 'brace' })),
        { x: (left.x + right.x) / 2, width: 2.2, operation: 'cross' },
        ...ordered.slice(index + 2).map(shelf => ({ ...shelf, operation: 'brace' }))]);
    }
    if (left.width > 1.2 || right.width > 1.2 || right.x - left.x > 1.35) continue;
    plans.push([...ordered.slice(0, index).map(shelf => ({ ...shelf, operation: 'brace' })),
      { x: (left.x + right.x) / 2, width: 2.2, operation: 'merge' },
      ...ordered.slice(index + 2).map(shelf => ({ ...shelf, operation: 'brace' }))]);
    plans.push([...ordered.slice(0, index).map(shelf => ({ ...shelf, operation: 'brace' })),
      { x: (left.x + right.x) / 2, width: 2.2, operation: 'cross' },
      ...ordered.slice(index + 2).map(shelf => ({ ...shelf, operation: 'brace' }))]);
  }
  const paired = new Map();
  ordered.slice(0, -1).map((left, index) => ({ index, gap: ordered[index + 1].x - left.x }))
    .sort((left, right) => left.gap - right.gap).forEach(({ index, gap }) => {
      const left = ordered[index]; const right = ordered[index + 1];
      if (gap <= cohesionReach(left, right) && !paired.has(index) && !paired.has(index + 1) && left.cohesion && right.cohesion
        && ![...left.cohesion].some(value => right.cohesion.has(value))) {
        paired.set(index, index + 1);
        paired.set(index + 1, index);
      }
    });
  if (paired.size) plans.push(ordered.flatMap((shelf, index) => {
    const partner = paired.get(index);
    if (partner === undefined) return [{ ...shelf, operation: 'hold' }];
    if (partner < index) return [];
    return [{ x: cohesionBridgeX(shelf, ordered[partner]), width: 2.2,
      operation: ordered.length <= 4 && (exploration + layer) % 3 === 1 ? 'merge' : 'cross' }];
  }));
  if (new Set(ordered.map(shelf => [...(shelf.cohesion ?? [])].sort((a, b) => a - b).join(','))).size > 1) {
    plans.push(ordered.map(shelf => ({
      ...shelf,
      x: shelf.x + Math.sign(center - shelf.x) * (shelf.width > 1.2 ? 0.68 : 0.14),
      operation: 'step',
    })));
  }
  if (ordered.length >= 2 && ordered.every(shelf => shelf.width <= 1.2)) {
    const steppedIndex = (layer + exploration) % ordered.length;
    const stepDirection = Math.floor((layer + exploration) / ordered.length) % 2 ? 1 : -1;
    plans.push(ordered.map((shelf, index) => ({
      ...shelf,
      x: shelf.x + Number(index === steppedIndex) * Math.sign(center - shelf.x) * stepDirection * 0.12,
      operation: index === steppedIndex ? 'step' : 'opening',
    })));
  }
  for (const direction of [-1, 1]) plans.push(ordered.map(shelf => ({
    ...shelf,
    x: shelf.x + direction * (shelf.width > 1.2 ? 0.23 : 0.134),
    operation: 'step',
  })));
  if (ordered.length >= 2) for (const direction of [-1, 1]) plans.push(ordered.map(shelf => ({
    ...shelf,
    x: shelf.x + Math.sign(shelf.x - center) * direction * 0.12,
    operation: 'step',
  })));
  if (ordered.length >= 2) {
    const grouped = [];
    for (let index = 0; index < ordered.length - 1;) {
      const left = ordered[index]; const right = ordered[index + 1];
      if (left.width <= 1.2 && right.width <= 1.2 && right.x - left.x <= 1.35) {
        const merged = { x: (left.x + right.x) / 2, width: 2.2, operation: 'merge' };
        if (!grouped.length || merged.x - grouped.at(-1).x >= 2.3) grouped.push(merged);
        index += 2;
      } else index += 1;
    }
    if (grouped.length) plans.push(grouped);
  }
  for (let index = 0; index < ordered.length; index += 1) if (ordered[index].width > 1.2) {
    const shelf = ordered[index];
    const splitOffsets = baseProfile.id === 'raised-plinth' ? [0.55, 0.7] : [0.55, 0.65];
    for (const splitOffset of splitOffsets) plans.push([
      ...ordered.slice(0, index).map(value => ({ ...value, operation: 'brace' })),
      { x: shelf.x - splitOffset, width: 0.9, operation: 'split' }, { x: shelf.x + splitOffset, width: 0.9, operation: 'split' },
      ...ordered.slice(index + 1).map(value => ({ ...value, operation: 'brace' })),
    ]);
    const narrowOffset = random() < 0.5 ? -0.15 : 0.15;
    plans.push([...ordered.slice(0, index).map(value => ({ ...value, operation: 'brace' })),
      { x: shelf.x + narrowOffset, width: 0.9, operation: 'narrow' },
      ...ordered.slice(index + 1).map(value => ({ ...value, operation: 'brace' }))]);
    const direction = (layer + exploration + index) % 2 ? -1 : 1;
    plans.push([...ordered.slice(0, index).map(value => ({ ...value, operation: 'brace' })),
      { x: shelf.x + direction * (random() < 0.5 ? 0.15 : 0.25), width: 2.2, operation: 'step' },
      ...ordered.slice(index + 1).map(value => ({ ...value, operation: 'brace' }))]);
  }
  for (const index of [0, ordered.length - 1]) {
    const shelf = ordered[index];
    if (!shelf || shelf.width > 1.2) continue;
    const wing = { x: shelf.x + (random() < 0.5 ? -wingOffset : wingOffset), width: 2.2, operation: 'wing' };
    const retained = ordered.filter((_, shelfIndex) => shelfIndex !== index)
      .filter(other => Math.abs(other.x - wing.x) >= (other.width + wing.width) / 2 + 0.04)
      .map(other => ({ ...other, operation: 'brace' }));
    plans.push([wing, ...retained].sort((left, right) => left.x - right.x));
  }
  if (ordered.length > 1) {
    const removed = Math.floor(random() * ordered.length);
    const truncated = ordered.filter((_, index) => index !== removed).map(shelf => ({ ...shelf, operation: 'brace' }));
    truncated[Math.min(removed, truncated.length - 1)].operation = 'truncate';
    plans.push(truncated);
    const terminal = ordered[random() < 0.5 ? 0 : ordered.length - 1];
    plans.push([{ ...terminal, operation: 'truncate' }]);
    if (ordered.length >= 4) {
      const start = random() < 0.5 ? 0 : Math.floor(ordered.length / 2);
      const retained = ordered.slice(start, start + Math.ceil(ordered.length / 2)).map(shelf => ({ ...shelf, operation: 'brace' }));
      retained[0].operation = 'truncate';
      plans.push(retained);
      const parity = random() < 0.5 ? 0 : 1;
      const alternating = ordered.filter((_, index) => index % 2 === parity).map(shelf => ({ ...shelf, operation: 'opening' }));
      alternating[0].operation = 'truncate';
      plans.push(alternating);
    }
  }
  const connectionDelay = Number(ordered.length <= 3 && exploration % 3 === 1);
  const connectionLayer = Math.max(1, (ordered.length >= 5 ? 2 : 3) + connectionDelay + baseProfile.connectionShift);
  const eligiblePlans = layer >= connectionLayer ? plans : plans.filter(plan => plan.every(child => (
    ['opening', 'brace'].includes(child.operation)
    || (ordered.length === 1 && ordered[0].width > 1.2 && child.operation === 'split')
  )));
  const unique = [...new Map(eligiblePlans.filter(plan => plan.length).map(plan => [planKey(plan), plan])).values()];
  if (rarityWeights) {
    const scores = new Map(unique.map(plan => {
      const weight = plan.reduce((sum, child) => sum + (rarityWeights[child.operation] ?? 1), 0) / plan.length;
      return [plan, -Math.log(Math.max(random(), Number.EPSILON)) / weight];
    }));
    unique.sort((left, right) => scores.get(left) - scores.get(right) || planKey(left).localeCompare(planKey(right)));
    if (!rarityWeights.batchMode) {
      const offset = (Math.floor(random() * unique.length) + exploration + layer) % unique.length;
      return [...unique.slice(offset), ...unique.slice(0, offset)];
    }
    const window = !rarityWeights.crossBatch || layer <= 2 ? 3 : (rarityWeights.cross ?? 1) < 0.5 ? unique.length : 3;
    const offset = (exploration + layer) % Math.min(window, unique.length);
    return [...unique.slice(offset), ...unique.slice(0, offset)];
  }
  const offset = (Math.floor(random() * unique.length) + exploration + layer) % unique.length;
  return [...unique.slice(offset), ...unique.slice(0, offset)];
}

function mergeMacroIntervals(intervals, maximumGap) {
  const ordered = [...intervals].sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (!previous || interval[0] - previous[1] > maximumGap) merged.push([...interval]);
    else previous[1] = Math.max(previous[1], interval[1]);
  }
  return merged;
}

function macroLayoutMetrics(children, frame) {
  const intervals = children.map(({ child }) => [
    child.x - child.width / 2,
    child.x + child.width / 2,
  ]);
  const spans = mergeMacroIntervals(intervals, frame.width * 0.04);
  const minX = Math.min(...spans.map(span => span[0]));
  const maxX = Math.max(...spans.map(span => span[1]));
  const occupiedWidth = spans.reduce((sum, span) => sum + span[1] - span[0], 0);
  const weightedCenter = spans.reduce((sum, span) => (
    sum + (span[0] + span[1]) / 2 * (span[1] - span[0])
  ), 0) / Math.max(occupiedWidth, Number.EPSILON);
  const centerVoid = spans.slice(0, -1).some((span, index) => {
    const next = spans[index + 1];
    return span[1] < frame.centerX && next[0] > frame.centerX && next[0] - span[1] >= frame.width * 0.08;
  });
  return {
    spanCount: spans.length,
    widthRatio: (maxX - minX) / frame.width,
    centerOffset: (weightedCenter - frame.centerX) / frame.width,
    centerVoid,
  };
}

function macroStageIndex(progress) {
  return Math.min(3, Math.floor(Math.min(progress, 0.999999) * 4));
}

function macroPlanScore(option, family, stageIndex, frame, direction) {
  const target = family.stages[stageIndex];
  const metrics = macroLayoutMetrics(option.children, frame);
  const alternatingOffset = family.stages.slice(2).some((stage, index) => (
    Math.sign(stage.centerOffset) !== Math.sign(family.stages[index + 1].centerOffset)
  ));
  const expectedOffset = target.centerOffset * direction * (alternatingOffset && stageIndex === 3 ? 1.3 : 1);
  const operations = option.children.map(value => value.child.operation).filter(operation => operation !== 'hold');
  return Math.abs(metrics.spanCount - target.spanCount) * 5
    + Math.abs(metrics.widthRatio - target.widthRatio) * 8
    + Math.abs(metrics.centerOffset - expectedOffset) * (alternatingOffset ? 100 : 10)
    + Number(!alternatingOffset && metrics.centerVoid !== target.centerVoid) * 7
    + Number(family.keepTwinTop && stageIndex >= 2 && metrics.spanCount < 2) * 100
    + Number(operations.some(operation => family.forbiddenOperations.includes(operation))) * 100;
}

export function historicalRarityWeights(descriptors) {
  const counts = { split: 0, merge: 0, opening: 0, cross: 0, step: 0, wing: 0, truncate: 0 };
  for (const descriptor of descriptors) {
    counts.split += Number(descriptor.topology.forks > 0);
    counts.merge += Number(descriptor.topology.merges > 0);
    counts.opening += Number(descriptor.topology.openings > 0);
    counts.cross += Number((descriptor.topology.crossLayerConnections ?? 0) > 0);
    counts.step += Number(descriptor.complexity.offsetChanges > 0);
    counts.wing += Number(descriptor.complexity.widthChanges > 0);
    const terminals = descriptor.complexity.terminalDepths;
    counts.truncate += Number(terminals.length > 1 && Math.max(...terminals) !== Math.min(...terminals));
  }
  return Object.fromEntries(Object.entries(counts).map(([operation, count]) => [operation, 1 / (1 + count)]));
}

function supportPositions(child, parents, offsets = child.width > 1.2 ? [-0.75, -0.25, 0.25, 0.75] : [-0.2, 0.2]) {
  const available = offsets.map(offset => child.x + offset).map(x => {
    const parent = parents.find(value => x >= value.x - value.width / 2 + 0.14 && x <= value.x + value.width / 2 - 0.14);
    return parent ? { x, parent } : null;
  }).filter(Boolean);
  const positions = [];
  for (const position of available) if (!positions.length || position.x - positions.at(-1).x >= 0.19) positions.push(position);
  return positions.length >= 2 && positions[0].x < child.x && positions.at(-1).x > child.x ? positions : null;
}

export function buildGeneratedCandidate({ seed, attempt, number, platformType, familyIndex = 0, macroFamilyKey = MACRO_FAMILY_KEYS[Math.abs(familyIndex) % MACRO_FAMILY_KEYS.length], assets, rarityWeights, budgetExponent = 1, preserveParallelRatio = 0.35, terminationRatio = 0.8, adaptiveConnections = false, wideStructuralFallback = false, randomizeCross = false, shiftFamilyOnRetry = true, structuralShape = familyIndex % 2 ? 'isosceles-triangle' : 'circle', localRetry = 0, familyRetry = 0, retryBaseAttempt = attempt }) {
  if (!PLATFORMS.includes(platformType)) throw new RangeError(`未知平台：${platformType}`);
  const macroFamily = MACRO_FAMILIES[macroFamilyKey];
  if (!macroFamily) throw new RangeError(`未知宏观建筑族：${macroFamilyKey}`);
  const macroDirection = createDeterministicRandom(
    `${seed}:candidate:${attempt}:${platformType}:${familyIndex}:${macroFamilyKey}:direction`,
  )() < 0.5 ? -1 : 1;
  const random = createDeterministicRandom(`${seed}:candidate:${attempt}:${platformType}:${familyIndex}`);
  const baseProfile = BASE_PROFILES[((familyIndex % BASE_PROFILES.length) + BASE_PROFILES.length) % BASE_PROFILES.length];
  const rootRegions = environmentSupports({ platformType });
  const targetBudget = MIN_OBJECTS + Math.floor(random() ** budgetExponent * (MAX_OBJECTS - MIN_OBJECTS + 1));
  const entries = [];
  const supports = new Map();
  const rewriteLog = [];
  const add = (shape, x, y, angle, role, parents = []) => {
    const entry = shapeObject(assets, shape, number, entries.length + 1, x, y, angle, role);
    entries.push(entry);
    supports.set(entry.object.id, [...parents]);
    return entry.object;
  };
  const recordRewrite = (operation, layer, beforeCount) => rewriteLog.push({
    operation, category: REWRITE_CATEGORIES[operation], layer, beforeCount, afterCount: entries.length,
    objectIds: entries.slice(beforeCount).map(entry => entry.object.id),
  });
  let shelves = [];
  let cohesionIdentityCount = 0;
  let circlePlaced = false;
  const raiseBand = (band, x) => {
    if (!baseProfile.raised) return band;
    const blockShape = 'square';
    const blockY = objectBounds(band).minY - assets.shapes[blockShape].shape.height / 2 + SUPPORT_EMBED;
    const blockOffsets = baseProfile.singleShelf ? [-0.6, 0, 0.6] : [-0.5, 0.5];
    const blocks = blockOffsets.map(offset => add(blockShape, x + offset, blockY, 0, 'foundation', [band]));
    const bandShape = 'long-thin-rectangle';
    const bandY = objectBounds(blocks[0]).minY - assets.shapes[bandShape].shape.height / 2 + SUPPORT_EMBED;
    return add(bandShape, x, bandY, 0, 'foundation', blocks);
  };
  for (const [platformIndex, platform] of rootRegions.entries()) {
    const segmentCount = 2;
    const segmentWidth = platform.width / segmentCount;
    if (platform.width <= 3) {
      const beforeCount = entries.length;
      const rootShape = 'square';
      const rootY = placementConstants.PLATFORM_TOP_Y - assets.shapes[rootShape].shape.height / 2;
      const rootCount = Math.round(platform.width / assets.shapes[rootShape].shape.width);
      const rootOffsets = Array.from({ length: rootCount }, (_, rootIndex) => (
        (rootIndex - (rootCount - 1) / 2) * assets.shapes[rootShape].shape.width
      ));
      let roots = rootOffsets.map(offset => add(rootShape, platform.centerX + offset, rootY, 0, 'foundation'));
      const foundationCourseCount = rootRegions.length === 1 && platform.width === 3 ? 3 : 1;
      for (let course = 1; course < foundationCourseCount; course += 1) {
        roots = roots.map((parent, rootIndex) => add(rootShape, platform.centerX + rootOffsets[rootIndex],
          objectBounds(parent).minY - assets.shapes[rootShape].shape.height / 2 + SUPPORT_EMBED,
          0, 'foundation', [parent]));
      }
      const bandShape = 'long-thin-rectangle';
      const bandY = objectBounds(roots[0]).minY
        - assets.shapes[bandShape].shape.height / 2 + SUPPORT_EMBED;
      const band = raiseBand(add(bandShape, platform.centerX, bandY, 0, 'foundation', roots), platform.centerX);
      const raisedBandY = band.y;
      const branchOffset = Math.min(baseProfile.branchOffset, segmentWidth / 2);
      const branchOffsets = baseProfile.singleShelf ? [0] : [-branchOffset, branchOffset];
      for (const offset of branchOffsets) shelves.push({
        x: platform.centerX + offset,
        y: raisedBandY,
        width: baseProfile.singleShelf ? shelfWidth(bandShape) : shelfWidth('short-thin-rectangle'),
        object: band,
        regions: new Set([platformIndex]),
        cohesion: new Set([cohesionIdentityCount++]),
      });
      recordRewrite('foot', 0, beforeCount);
      continue;
    }

    const beamShape = 'long-thin-rectangle';
    const beamWidth = shelfWidth(beamShape);

    for (let segment = 0; segment < segmentCount; segment += 1) {
      const beforeCount = entries.length;
      const x = platform.centerX + (segment ? baseProfile.segmentOffset : -baseProfile.segmentOffset);
      const rootShape = 'square';
      const rootY = placementConstants.PLATFORM_TOP_Y
        - assets.shapes[rootShape].shape.height / 2;
      const rootCount = Math.round(platform.width / segmentCount / assets.shapes[rootShape].shape.width);
      const roots = Array.from({ length: rootCount }, (_, rootIndex) => (
        (rootIndex - (rootCount - 1) / 2) * assets.shapes[rootShape].shape.width
      )).map(offset => add(rootShape, x + offset, rootY, 0, 'foundation'));
      const beamY = objectBounds(roots[0]).minY
        - assets.shapes[beamShape].shape.height / 2 + SUPPORT_EMBED;
      const beam = raiseBand(add(beamShape, x, beamY, 0, 'foundation', roots), x);

      shelves.push({
        x,
        y: beam.y,
        width: beamWidth,
        object: beam,
        regions: new Set([platformIndex]),
        cohesion: new Set([cohesionIdentityCount++]),
      });
      recordRewrite('foot', 0, beforeCount);
    }
  }
  const initialMinX = Math.min(...shelves.map(shelf => shelf.x - shelf.width / 2));
  const initialMaxX = Math.max(...shelves.map(shelf => shelf.x + shelf.width / 2));
  const bodyStartCount = entries.length;
  const growthBudget = macroFamilyKey === 'zigzag-terrace'
    ? Math.max(MIN_OBJECTS + 7, targetBudget) : targetBudget;
  const macroFrame = {
    centerX: (initialMinX + initialMaxX) / 2,
    width: Math.max(2.2, initialMaxX - initialMinX),
  };
  const initialShelfSpan = shelves.length > 1
    ? shelves.at(-1).x - shelves[0].x : 0;
  const initialShelfGap = shelves.length > 1
    ? Math.max(...shelves.slice(1).map((shelf, index) => shelf.x - shelves[index].x)) : 0;
  let layer = 1;
  let localFailures = 0;
  let previousLayerTemplate = '';
  let repeatedLayerTemplateCount = 0;
  const isCohesive = () => shelves.some(shelf => shelf.cohesion.size === cohesionIdentityCount);
  while ((entries.length < growthBudget || !isCohesive()) && layer <= 12) {
    let choice = null;
    const progress = macroFamilyKey === 'zigzag-terrace'
      ? (entries.length - bodyStartCount) / (growthBudget - bodyStartCount)
      : entries.length / targetBudget;
    const stageIndex = macroFamilyKey === 'zigzag-terrace'
      ? (progress < 0.25 ? 0 : progress < 0.4 ? 1 : progress < 0.75 ? 2 : 3)
      : macroStageIndex(progress);
    const currentMetrics = macroLayoutMetrics(shelves.map(shelf => ({ child: shelf })), macroFrame);
    const targetMacroOffset = macroFamily.stages[stageIndex].centerOffset * macroDirection
      * (macroFamilyKey === 'zigzag-terrace' && stageIndex === 3 ? 1.3 : 1);
    const macroStageTolerance = macroFamilyKey === 'zigzag-terrace' && stageIndex === 3 ? 0.01 : 0.04;
    const macroStageReady = macroFamilyKey !== 'zigzag-terrace'
      || Math.sign(targetMacroOffset) * currentMetrics.centerOffset >= Math.abs(targetMacroOffset) - macroStageTolerance;
    if (macroFamilyKey === 'zigzag-terrace' && stageIndex === 3 && macroStageReady
      && entries.length >= MIN_OBJECTS && rewriteLog.length >= 12 && isCohesive()) break;
    let plans = nextPlans(shelves, random, layer, familyIndex, rarityWeights, baseProfile);
    if (progress < 0.45) {
      plans = plans.filter(plan => plan.every(child => !['wing', 'truncate'].includes(child.operation)
        && (child.operation !== 'narrow' || macroFamilyKey === 'gatehouse')));
    } else if (progress < 0.75) {
      plans = plans.filter(plan => plan.every(child => child.operation !== 'truncate'));
    }
    if (macroFamilyKey === 'zigzag-terrace') {
      const targetOffset = targetMacroOffset;
      const maximumShift = 0.27;
      const shift = Math.max(-maximumShift, Math.min(maximumShift,
        (targetOffset - currentMetrics.centerOffset) * macroFrame.width));
      if (Math.abs(shift) >= 0.04) plans.push(shelves.map(shelf => ({ ...shelf, x: shelf.x + shift, operation: 'step' })));
    }
    const choices = [];
    for (const plan of plans) {
      const children = plan.map((child, childIndex) => {
        if (child.operation === 'hold') return { child, positions: [] };
        const nearestParent = shelves.reduce((nearest, shelf) => (
          Math.abs(shelf.x - child.x) < Math.abs(nearest.x - child.x) ? shelf : nearest
        ));
        const offsets = ['merge', 'cross'].includes(child.operation) && !isCohesive()
          ? [-0.72, -0.24, 0.24, 0.72]
          : child.width > 1.2 ? [-0.72, 0, 0.72] : child.operation === 'step'
            ? (macroFamilyKey === 'zigzag-terrace'
              ? (child.x >= nearestParent.x ? [-0.32, 0.04] : [-0.04, 0.32])
              : [-0.175, 0.175])
            : [-0.22, 0.22];
        const positions = supportPositions(child, shelves, offsets) ?? [];
        return { child, positions };
      });
      if (children.some(value => !value.positions) || children.some(({ child }) => child.x - child.width / 2 < 0.18 || child.x + child.width / 2 > 8.82)) continue;
      if (children.some(value => value.child.operation !== 'hold' && value.positions.length < 2)) continue;
      if (children.some(value => value.child.operation !== 'cross' && value.child.width > 1.2
        && value.positions.slice(1).some((position, index) => position.x - value.positions[index].x < assets.shapes['small-square'].shape.width))) continue;
      if (children.some(value => ['merge', 'cross'].includes(value.child.operation)
        && Math.max(...value.positions.map(position => position.parent.y)) - Math.min(...value.positions.map(position => position.parent.y)) > 0.02)) continue;
      const projected = entries.length + children.reduce((sum, value) => sum + (value.child.operation === 'hold' ? 2 : value.child.operation === 'cross'
        ? 5 : value.positions.length + 1), 0);
      if (plan.some(child => child.operation === 'truncate') && projected < Math.max(MIN_OBJECTS, targetBudget)) continue;
      const budgetSlack = macroFamilyKey === 'zigzag-terrace' ? 12 : 3;
      if (projected > MAX_OBJECTS || (isCohesive() && entries.length >= MIN_OBJECTS && rewriteLog.length >= 12 && projected > targetBudget + budgetSlack)) continue;
      const builtChildren = plan.filter(child => child.operation !== 'hold');
      const overlaps = builtChildren.some((left, index) => builtChildren.slice(index + 1).some(right => Math.abs(left.x - right.x) < (left.width + right.width) / 2 + 0.04));
      if (!overlaps) choices.push({
        template: plan.map(child => `${child.operation}:${child.width}`).join('|'),
        projected,
        children: children.map(value => ({
          ...value,
          regions: value.child.operation === 'hold' ? new Set(value.child.regions) : new Set(value.positions.flatMap(position => [...position.parent.regions])),
          cohesion: value.child.operation === 'hold' ? new Set(value.child.cohesion) : new Set(value.positions.flatMap(position => [...position.parent.cohesion])),
        })),
      });
    }
    const cohesive = isCohesive();
    const joinsComponents = value => ['cross', 'merge'].includes(value.child.operation)
      && value.cohesion.size > Math.max(0, ...value.positions.map(position => position.parent.cohesion.size));
    const preservesJoinHeight = option => {
      const joining = option.children.some(joinsComponents);
      return joining
        ? option.children.every(value => value.child.operation === 'hold' || joinsComponents(value))
        : option.children.every(value => ['step', 'opening', 'brace'].includes(value.child.operation));
    };
    const structuralChoices = choices.filter(option => (!cohesive
      ? preservesJoinHeight(option)
      : option.projected < targetBudget || option.children.some(child => !['cross', 'hold'].includes(child.child.operation) && child.child.width <= 1.2)));
    const cohesionChoices = cohesive ? structuralChoices : structuralChoices.filter(option => (
      new Set(option.children.flatMap(child => [...child.cohesion])).size === cohesionIdentityCount
    ));
    const cohesionGroupCount = option => new Set(option.children.map(child => [...child.cohesion].sort((a, b) => a - b).join(','))).size;
    const cohesionGap = option => {
      const orderedChildren = [...option.children].sort((left, right) => left.child.x - right.child.x);
      return Math.max(0, ...orderedChildren.slice(0, -1).map((left, index) => {
        const right = orderedChildren[index + 1];
        return right.child.x - left.child.x - cohesionReach(left.child, right.child);
      }));
    };
    if (!cohesive) cohesionChoices.sort((left, right) => (
      Number(right.children.some(joinsComponents)) - Number(left.children.some(joinsComponents))
      || cohesionGroupCount(left) - cohesionGroupCount(right)
      || cohesionGap(left) - cohesionGap(right)
      || Math.max(...right.children.map(child => child.cohesion.size)) - Math.max(...left.children.map(child => child.cohesion.size))
      || Number(right.children.some(child => ['merge', 'cross'].includes(child.child.operation)))
        - Number(left.children.some(child => ['merge', 'cross'].includes(child.child.operation)))
    ));
    const macroChoices = cohesionChoices.filter(option => {
      const operations = option.children.map(value => value.child.operation).filter(operation => operation !== 'hold');
      const metrics = macroLayoutMetrics(option.children, macroFrame);
      if (operations.some(operation => macroFamily.forbiddenOperations.includes(operation))) return false;
      if (macroFamily.initialTwin && stageIndex === 0 && currentMetrics.spanCount < 2) return operations.includes('split');
      if (stageIndex > 0 && operations.includes('split')) return false;
      if (macroFamilyKey === 'bridge-fortress') {
        if (stageIndex >= 2 && metrics.spanCount < 2 && !operations.includes('cross')) return false;
        if (stageIndex >= 2 && !rewriteLog.some(entry => entry.operation === 'cross') && !operations.includes('cross')) return false;
      }
      if (macroFamilyKey === 'gatehouse' && currentMetrics.spanCount >= 2) {
        if (stageIndex < 3 && operations.includes('merge')) return false;
        if (stageIndex >= 3 && !operations.includes('merge')) return false;
      }
      if (macroFamilyKey === 'central-hall' && stageIndex >= 2 && metrics.widthRatio < 0.50) return false;
      return true;
    });
    macroChoices.sort((left, right) => (
      macroPlanScore(left, macroFamily, stageIndex, macroFrame, macroDirection)
      - macroPlanScore(right, macroFamily, stageIndex, macroFrame, macroDirection)
      || left.projected - right.projected
    ));
    choice = macroChoices[0] ?? null;
    if (!choice) {
      localFailures += 1;
      if (localFailures >= 24) break;
      continue;
    }
    if (choice.template === previousLayerTemplate) repeatedLayerTemplateCount += 1;
    else {
      previousLayerTemplate = choice.template;
      repeatedLayerTemplateCount = 1;
    }
    const next = [];
    const nextCohesive = choice.children.some(child => child.cohesion.size === cohesionIdentityCount);
    const projectedRewriteCount = rewriteLog.length + choice.children.filter(value => value.child.operation !== 'hold').length;
    const macroCanTerminate = macroFamilyKey !== 'zigzag-terrace' || (stageIndex === 3 && macroStageReady);
    let structuralChild = macroCanTerminate && nextCohesive && choice.children.length >= 2 && choice.projected >= MIN_OBJECTS && projectedRewriteCount >= 12
      ? choice.children.findIndex(value => !['cross', 'hold'].includes(value.child.operation) && value.child.width <= 1.2) : -1;
    if (macroCanTerminate && wideStructuralFallback && structuralChild < 0 && choice.projected >= MIN_OBJECTS && projectedRewriteCount >= 12) {
      structuralChild = choice.children.findIndex(value => !['cross', 'hold'].includes(value.child.operation));
    }
    for (const [childIndex, { child, positions, regions, cohesion }] of choice.children.entries()) {
      const beforeCount = entries.length;
      if (child.operation === 'hold') {
        const parent = child.object;
        const structureCenter = (shelves[0].x + shelves.at(-1).x) / 2;
        const expandStructure = initialShelfSpan < 3.5 || initialShelfGap > 1.5;
        const holdX = expandStructure && nextCohesive
          ? child.x + Math.sign(child.x - structureCenter) * 0.35 : child.x;
        const block = add('rectangle', holdX,
          objectBounds(parent).minY - assets.shapes.rectangle.shape.height / 2 + SUPPORT_EMBED, 0, 'post', [parent]);
        const beamShape = 'short-thin-rectangle';
        const beamY = objectBounds(block).minY - assets.shapes[beamShape].shape.height / 2 + SUPPORT_EMBED;
        const beam = add(beamShape, holdX, beamY, 0, 'beam', [block]);
        next.push({ ...child, x: holdX, width: assets.shapes[beamShape].shape.width, y: beamY, object: beam, regions, cohesion });
        continue;
      }
      if (child.operation === 'cross') {
        const [left, right] = randomizeCross && random() < 0.5
          ? [positions.at(-1), positions[0]] : [positions[0], positions.at(-1)];
        const leftTop = objectBounds(left.parent.object).minY;
        const leftBlock = add('rectangle', left.x,
          leftTop - assets.shapes.rectangle.shape.height / 2 + SUPPORT_EMBED, 0, 'post', [left.parent.object]);
        let rightParent = right.parent.object;
        let rightTop = objectBounds(rightParent).minY;
        for (let row = 0; row < 2; row += 1) {
          rightParent = add('short-thin-rectangle', right.x,
            rightTop - assets.shapes['short-thin-rectangle'].shape.height / 2 + SUPPORT_EMBED, 0, 'post', [rightParent]);
          rightTop = objectBounds(rightParent).minY;
        }
        const beamShape = 'long-thin-rectangle';
        const beamY = Math.max(objectBounds(leftBlock).minY, rightTop)
          - assets.shapes[beamShape].shape.height / 2 + SUPPORT_EMBED;
        const beam = add(beamShape, child.x, beamY, 0, layer >= 8 ? 'crown' : 'beam', [leftBlock, rightParent]);
        let placedCircleHere = false;
        if (structuralShape === 'circle' && !circlePlaced && cohesion.size === cohesionIdentityCount) {
          add('circle', child.x, objectBounds(beam).minY - assets.shapes.circle.shape.radius + SUPPORT_EMBED, 0, 'counterweight', [beam]);
          circlePlaced = true;
          placedCircleHere = true;
        }
        for (const [index, position] of [left, right].entries()) next.push({ ...child, x: placedCircleHere
          ? child.x + (index ? 0.7 : -0.7) : Math.max(child.x - 0.7, Math.min(child.x + 0.7, position.parent.x)), width: 0.9, y: beamY, object: beam, regions, cohesion });
        recordRewrite('cross', layer, beforeCount);
        continue;
      }
      const tops = [];
      const compactGateUpper = macroFamilyKey === 'gatehouse' && stageIndex >= 2;
      const postShape = child.width > 1.2 && !compactGateUpper ? 'rectangle' : 'small-square';
      const postAngle = Math.PI / 2;
      const postBounds = objectBounds({ x: 0, y: 0, angle: postAngle, shape: assets.shapes[postShape].shape });
      const postHeight = postBounds.maxY - postBounds.minY;
      const buildPositions = childIndex === structuralChild && child.width > 1.2
        ? positions.filter(position => Math.abs(position.x - child.x) <= 0.3) : positions;
      for (const position of buildPositions) {
        const supportTop = objectBounds(position.parent.object).minY;
        tops.push(add(postShape, position.x, supportTop - postHeight / 2 + SUPPORT_EMBED,
          postAngle, 'post', [position.parent.object]));
      }
      const beamShape = childIndex === structuralChild && structuralShape !== 'circle'
        ? structuralShape : shelfShape(child.width);
      const shapeBounds = objectBounds({ x: 0, y: 0, angle: 0, shape: assets.shapes[beamShape].shape });
      const beamHalfHeight = (shapeBounds.maxY - shapeBounds.minY) / 2;
      const y = objectBounds(tops[0]).minY - beamHalfHeight + SUPPORT_EMBED;
      const beam = add(beamShape, child.x, y, 0, childIndex === structuralChild || layer >= 8 ? 'crown' : 'beam', tops);
      next.push({ ...child, width: assets.shapes[beamShape].shape.width, y, object: beam, regions, cohesion });
      recordRewrite(child.operation, layer, beforeCount);
    }
    for (const joined of choice.children.filter(value => ['cross', 'merge'].includes(value.child.operation)).map(value => value.cohesion)) {
      for (const shelf of next) if ([...shelf.cohesion].some(identity => joined.has(identity))) {
        shelf.cohesion = new Set([...shelf.cohesion, ...joined]);
      }
    }
    shelves = next;
    layer += 1;
    if (macroCanTerminate && isCohesive() && entries.length >= MIN_OBJECTS && rewriteLog.length >= 12
      && choice.children.some(value => value.child.operation === 'cross')) break;
    if (structuralChild >= 0) break;
  }
  if (entries.length < MIN_OBJECTS || entries.length > MAX_OBJECTS || rewriteLog.length < 12 || rewriteLog.length > MAX_REWRITES) {
    if (localRetry < LOCAL_RETRY_OFFSETS.length) return buildGeneratedCandidate({ seed, attempt: attempt + LOCAL_RETRY_OFFSETS[localRetry], number, platformType, familyIndex, macroFamilyKey, assets, rarityWeights, budgetExponent, preserveParallelRatio, terminationRatio, adaptiveConnections, wideStructuralFallback, randomizeCross, shiftFamilyOnRetry, structuralShape, localRetry: localRetry + 1, familyRetry, retryBaseAttempt });
    if (shiftFamilyOnRetry && familyRetry < 4) return buildGeneratedCandidate({ seed, attempt: retryBaseAttempt, number, platformType, familyIndex: familyIndex + 4, macroFamilyKey, assets, rarityWeights, budgetExponent, preserveParallelRatio, terminationRatio, adaptiveConnections, wideStructuralFallback, randomizeCross, shiftFamilyOnRetry, structuralShape, familyRetry: familyRetry + 1, retryBaseAttempt });
    if (entries.length < MIN_OBJECTS || entries.length > MAX_OBJECTS) throw new Error(`预算化改写无法在 70–100 件内落地（${entries.length} 件/${rewriteLog.length} 次/失败 ${localFailures}/${shelves.map(shelf => `${shelf.x.toFixed(2)}:${shelf.width}:${shelf.y.toFixed(2)}:${[...shelf.cohesion].join('.')}`).join('|')}/${rewriteLog.map(entry => entry.operation).join(',')}）`);
    throw new Error(`有效支撑图改写次数不在 12–${MAX_REWRITES} 范围（${rewriteLog.length}）`);
  }
  assignMaterials(entries, supports);
  const level = {
    levelNumber: number, levelName: '结构候选', difficulty: 'normal', description: '自定义生成关卡',
    normalAmmo: 15, explosiveAmmo: 1, splitAmmo: 0, blackHoleAmmo: 0, platformType,
    castle: entries.map(entry => entry.object),
    __levelDocument: { version: 2, type: 'level', levelId: `level-${number}`, rootExtensions: {} },
  };
  const descriptor = reconstructLevelStructure(level, assets);
  const invalidOverlap = findInvalidOverlap(level.castle, descriptor);
  const riskyConstruction = descriptor.complexity.widthChanges < 2 || descriptor.topology.forks + descriptor.topology.merges < 1
    || descriptor.connectedComponentCount !== 1 || invalidOverlap || descriptor.maxDepth > 27
    || (descriptor.maxDepth > 12 && rewriteLog.some(entry => entry.operation === 'wing'));
  if (riskyConstruction && localRetry < LOCAL_RETRY_OFFSETS.length) return buildGeneratedCandidate({ seed, attempt: attempt + LOCAL_RETRY_OFFSETS[localRetry], number, platformType, familyIndex, macroFamilyKey, assets, rarityWeights, budgetExponent, preserveParallelRatio, terminationRatio, adaptiveConnections, wideStructuralFallback, randomizeCross, shiftFamilyOnRetry, structuralShape, localRetry: localRetry + 1, familyRetry, retryBaseAttempt });
  if (riskyConstruction && shiftFamilyOnRetry && familyRetry < 4) return buildGeneratedCandidate({ seed, attempt: retryBaseAttempt, number, platformType, familyIndex: familyIndex + 4, macroFamilyKey, assets, rarityWeights, budgetExponent, preserveParallelRatio, terminationRatio, adaptiveConnections, wideStructuralFallback, randomizeCross, shiftFamilyOnRetry, structuralShape, familyRetry: familyRetry + 1, retryBaseAttempt });
  if (riskyConstruction) throw new Error(`解析稳定余量不足（${entries.length}/${targetBudget}/${descriptor.connectedComponentCount}/${descriptor.maxDepth}/width=${descriptor.complexity.widthChanges}/forks=${descriptor.topology.forks}/merges=${descriptor.topology.merges}/overlap=${invalidOverlap?.map(id => { const object = entries.find(entry => entry.object.id === id)?.object; return `${id}:${object?.shapePresetId}:${object?.x}:${object?.y}`; }).join('>') ?? 'none'}/cross=${JSON.stringify(rewriteLog.filter(entry => entry.operation === 'cross').map(entry => entry.objectIds.map(id => { const node = descriptor.nodes.find(value => value.id === id); const object = entries.find(value => value.object.id === id)?.object; return [id, object?.shapePresetId, object?.x, object?.y, node?.parentIds, supports.get(id)?.map(parent => [parent.id, parent.x, parent.y])]; })))}/${descriptor.complexity.terminalDepths.join(',')}/${rewriteLog.map(entry => entry.operation).join(',')}）`);
  level.levelName = macroCategoryLabel(descriptor.topologyKey);
  const candidate = {
    level, family: descriptor.topologyKey, familyName: macroCategoryLabel(descriptor.topologyKey), macroFamilyKey, macroFamilyName: macroFamily.label, platformType, supports,
    baseFamily: baseProfile.id, attempt, suggestedNumber: number, rewriteLog, descriptor,
  };
  return candidate;
}

function countMaterials(level) {
  const counts = Object.fromEntries(Object.keys(MATERIAL_MINIMUMS).map(id => [id, 0]));
  for (const object of level.castle ?? []) if (Object.hasOwn(counts, object.materialId)) counts[object.materialId] += 1;
  return counts;
}

function findInvalidOverlap(objects, descriptor) {
  const directSupports = new Set(descriptor.nodes.flatMap(node => node.parentIds.map(parentId => `${parentId}>${node.id}`)));
  const bounds = objects.map(objectBounds);
  for (let left = 0; left < objects.length; left += 1) for (let right = left + 1; right < objects.length; right += 1) {
    if (bounds[left].maxX - bounds[right].minX <= placementConstants.OVERLAP_TOLERANCE
      || bounds[right].maxX - bounds[left].minX <= placementConstants.OVERLAP_TOLERANCE
      || bounds[left].maxY - bounds[right].minY <= placementConstants.OVERLAP_TOLERANCE
      || bounds[right].maxY - bounds[left].minY <= placementConstants.OVERLAP_TOLERANCE) continue;
    if (!shapesOverlap(objects[left], objects[right])) continue;
    const upper = objects[left].y < objects[right].y ? left : right;
    const lower = upper === left ? right : left;
    const upperBounds = bounds[upper];
    const lowerBounds = bounds[lower];
    const penetration = upperBounds.maxY - lowerBounds.minY;
    const horizontalContact = Math.min(upperBounds.maxX, lowerBounds.maxX) - Math.max(upperBounds.minX, lowerBounds.minX);
    if (penetration <= MAX_DIRECT_SUPPORT_EMBED + 1e-6 && horizontalContact >= placementConstants.SUPPORT_MIN_OVERLAP
      && directSupports.has(`${objects[lower].id}>${objects[upper].id}`)) continue;
    return [objects[left].id, objects[right].id];
  }
  return null;
}

const average = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

export function validateMacroFamilyContract(descriptor, macroFamilyKey) {
  const profile = descriptor.macroProfile ?? [];
  if (profile.length !== 6) return { ok: false, code: 'macro-profile-missing' };

  const lower = profile.slice(0, 2);
  const upper = profile.slice(4, 6);
  const lowerWidth = average(lower.map(value => value.envelopeWidth));
  const upperWidth = average(upper.map(value => value.envelopeWidth));
  const upperSpan = average(upper.map(value => value.spanCount));
  const maximumOffset = Math.max(...profile.map(value => Math.abs(value.centerOffset)));
  const upperOffset = average(upper.map(value => Math.abs(value.centerOffset)));
  const widthDrops = profile.slice(1).filter((value, index) => (
    profile[index].envelopeWidth - value.envelopeWidth >= 0.08
  )).length;
  const significantOffsets = profile.map(value => value.centerOffset).filter(value => Math.abs(value) >= 0.06);
  const offsetSignChanges = significantOffsets.slice(1).filter((value, index) => (
    Math.sign(value) !== Math.sign(significantOffsets[index])
  )).length;
  const middleVoids = profile.slice(1, 4).filter(value => value.centerVoid).length;
  const upperTwinBands = upper.filter(value => value.spanCount >= 2).length;

  const ok = macroFamilyKey === 'stepped-keep'
    ? lowerWidth - upperWidth >= 0.20 && upperSpan <= 1.5 && maximumOffset <= 0.14 && widthDrops >= 2
    : macroFamilyKey === 'gatehouse'
      ? middleVoids >= 2 && upperSpan <= 1.5 && upper.every(value => !value.centerVoid)
      : macroFamilyKey === 'asymmetric-keep'
        ? maximumOffset >= 0.18 && upperOffset >= 0.14 && upper.every(value => value.centerOffset >= 0.06)
        : macroFamilyKey === 'central-hall'
          ? upperWidth >= 0.48 && average(upper.map(value => value.largestSpanWidth)) >= 0.40
            && upperSpan <= 1.5 && maximumOffset <= 0.12 && lowerWidth - upperWidth <= 0.30
          : macroFamilyKey === 'bridge-fortress'
            ? profile.slice(1, 5).filter(value => value.centerVoid).length >= 2 && upperTwinBands >= 1
              && profile.some((value, index) => index >= 2 && index <= 4 && !value.centerVoid)
            : macroFamilyKey === 'zigzag-terrace'
              ? offsetSignChanges >= 2 && maximumOffset >= 0.14 && widthDrops >= 2
              : false;

  return {
    ok,
    code: ok ? null : 'macro-family-contract',
    details: {
      macroFamilyKey, lowerWidth, upperWidth, upperSpan, maximumOffset, upperOffset,
      widthDrops, offsetSignChanges, middleVoids, upperTwinBands, profile,
    },
  };
}

export function validateGeneratedCandidate(candidate, { assets, knownSignatures = new Set(), knownDescriptors = [], reconstructedDescriptor } = {}) {
  const { level } = candidate;
  const documentValidation = validateLevel(level, assets);
  if (!documentValidation.ok) return { ok: false, reason: 'material', details: documentValidation.errors };
  const objects = level.castle ?? [];
  const descriptor = reconstructedDescriptor ?? reconstructLevelStructure(level, assets);
  const byId = new Map(objects.map(object => [object.id, object]));
  for (const node of descriptor.nodes) if (node.parentIds.length === 1 && byId.get(node.parentIds[0])?.materialId === 'rubber') {
    return { ok: false, reason: 'support', details: { code: 'sole-rubber-support', child: node.id, parent: node.parentIds[0] } };
  }
  if (candidate.rewriteLog) {
    const usedIds = new Set();
    const nodes = new Map(descriptor.nodes.map(node => [node.id, node]));
    const validEntry = entry => {
      if (REWRITE_CATEGORIES[entry.operation] !== entry.category || !Number.isInteger(entry.beforeCount) || !Number.isInteger(entry.afterCount)
        || entry.beforeCount < 0 || entry.afterCount <= entry.beforeCount || entry.afterCount > objects.length) return false;
      const objectIds = objects.slice(entry.beforeCount, entry.afterCount).map(object => object.id);
      if (!Array.isArray(entry.objectIds) || objectIds.join('|') !== entry.objectIds.join('|') || objectIds.some(id => usedIds.has(id))) return false;
      objectIds.forEach(id => usedIds.add(id));
      return objectIds.some(id => nodes.get(id)?.parentIds.length || nodes.get(id)?.rootRegions.length);
    };
    if (candidate.rewriteLog.length < 12 || candidate.rewriteLog.length > MAX_REWRITES || !candidate.rewriteLog.every(validEntry)) {
      return { ok: false, reason: 'complexity', details: { code: 'rewrite-evidence-mismatch', rewriteLog: candidate.rewriteLog } };
    }
  }
  const counts = countMaterials(level);
  const woodRatio = counts.wood / objects.length;
  if (level.frozenBodies?.length || objects.some(object => object.fixedBolt === true || object.specialType === 'explosive-barrel')) return { ok: false, reason: 'material' };
  for (const object of objects) {
    const bounds = objectBounds(object);
    if (bounds.minX < placementConstants.WORLD_MIN_X || bounds.maxX > placementConstants.WORLD_MAX_X || bounds.minY < 0 || bounds.maxY > placementConstants.PLATFORM_TOP_Y + 1e-6) return { ok: false, reason: 'bounds', details: object.id };
  }
  const invalidOverlap = findInvalidOverlap(objects, descriptor);
  if (invalidOverlap) return { ok: false, reason: 'overlap', details: invalidOverlap };
  const unreachable = descriptor.nodes.find(node => node.depth <= 0 || node.rootRegions.length === 0);
  if (unreachable) return { ok: false, reason: 'support', details: { code: 'not-platform-reachable', objectId: unreachable.id } };
  if (descriptor.connectedComponentCount !== 1) {
    return { ok: false, reason: 'support', details: {
      code: 'detached-structure', connectedComponentCount: descriptor.connectedComponentCount,
      largestComponentRatio: descriptor.largestComponentRatio, detachedComponentSizes: descriptor.detachedComponentSizes,
    } };
  }
  if (descriptor.topology.platformRegionCount > 1 && descriptor.topology.crossPlatformNodes < 1) {
    return { ok: false, reason: 'support', details: { code: 'double-platform-disconnected' } };
  }
  if (objects.length < MIN_OBJECTS || objects.length > MAX_OBJECTS || descriptor.maxDepth < 8 || descriptor.rootPathCount < 2
    || descriptor.topology.forks + descriptor.topology.merges < 1 || descriptor.topology.connectors < 1 || descriptor.topology.openings < 1
    || descriptor.complexity.widthChanges < 2 || descriptor.complexity.effectiveRewriteCount < 12 || descriptor.complexity.categories.length < 5) {
    return { ok: false, reason: 'complexity', details: { maxDepth: descriptor.maxDepth, roots: descriptor.rootPathCount, topology: descriptor.topology, complexity: descriptor.complexity } };
  }
  const macroContract = validateMacroFamilyContract(descriptor, candidate.macroFamilyKey);
  if (!macroContract.ok) return { ok: false, reason: 'complexity', details: macroContract };
  if (Object.entries(MATERIAL_MINIMUMS).some(([id, minimum]) => counts[id] < minimum) || counts.glass > Math.floor(objects.length * 0.1)
    || counts.stone + counts.metal < Math.ceil(objects.length * 0.6) || woodRatio < 0.23 || woodRatio > 0.27) {
    return { ok: false, reason: 'material', details: { counts, woodRatio } };
  }
  const bounds = objects.map(objectBounds);
  const boxArea = (Math.max(...bounds.map(value => value.maxX)) - Math.min(...bounds.map(value => value.minX))) * (Math.max(...bounds.map(value => value.maxY)) - Math.min(...bounds.map(value => value.minY)));
  const occupied = objects.reduce((sum, object) => sum + (object.shape.kind === 'box' ? object.shape.width * object.shape.height : (objectBounds(object).maxX - objectBounds(object).minX) * (objectBounds(object).maxY - objectBounds(object).minY)), 0);
  if (!boxArea || occupied / boxArea > 0.7) return { ok: false, reason: 'complexity', details: { occupancy: occupied / boxArea } };
  const architecture = descriptor.architecture;
  if (architecture.foundationContinuity < 0.62
    || architecture.majorBandCount < 2
    || architecture.lowerCohesion < 0.30
    || architecture.maxDensePostRun > 2) {
    return {
      ok: false,
      reason: 'complexity',
      details: { code: 'architectural-cohesion', architecture },
    };
  }
  const signature = structureSignature(descriptor);
  if (knownSignatures.has(signature)) return { ok: false, reason: 'duplicate' };
  let nearest = null;
  for (const entry of knownDescriptors) {
    const comparison = isNearDuplicate(descriptor, entry.descriptor ?? entry);
    if (!nearest || comparison.contourJaccard > nearest.contourJaccard) nearest = { ...comparison, id: entry.id ?? null, level: entry.level ?? null, descriptor: entry.descriptor ?? entry };
    if (comparison.duplicate) return { ok: false, reason: 'duplicate', details: nearest };
  }
  return { ok: true, signature, descriptor, nearest, metrics: { count: objects.length, counts, woodRatio, depth: descriptor.maxDepth, openings: descriptor.topology.openings, occupancy: occupied / boxArea, topologyKey: descriptor.topologyKey, rewriteCount: candidate.rewriteLog?.length ?? null } };
}

export function renumberGeneratedLevel(level, number) {
  const previous = Number(level.levelNumber);
  const next = clone(level);
  next.levelNumber = number;
  next.__levelDocument = { ...(next.__levelDocument ?? {}), version: 2, type: 'level', levelId: `level-${number}`, rootExtensions: clone(next.__levelDocument?.rootExtensions ?? {}) };
  next.castle = (next.castle ?? []).map((object, index) => ({ ...object, id: object.id.startsWith(`generated-${previous}-`) ? `generated-${number}-${String(index + 1).padStart(3, '0')}` : object.id }));
  return next;
}

export function reserveCandidateNumbers(candidates, occupiedNumbers, occupiedPaths = new Set()) {
  const numbers = new Set([...occupiedNumbers].map(Number));
  const paths = new Set(occupiedPaths);
  let floor = Math.min(...candidates.map(candidate => candidate.suggestedNumber));
  return [...candidates].sort((a, b) => a.suggestedNumber - b.suggestedNumber).map(candidate => {
    let number = Math.max(floor, candidate.suggestedNumber);
    const pathFor = value => `level/${exportedLevelFilename({ number: value, name: candidate.level.levelName })}`;
    while (numbers.has(number) || paths.has(pathFor(number))) number += 1;
    numbers.add(number);
    const path = pathFor(number);
    paths.add(path);
    floor = number + 1;
    return { ...candidate, suggestedNumber: number, level: renumberGeneratedLevel(candidate.level, number), fileName: path.slice('level/'.length), filePath: path };
  });
}

const batchRules = targetCount => targetCount === 5 ? { minimumAccepted: 4, minimumCategories: 4, categoryLimit: 2 }
  : targetCount === 10 ? { minimumAccepted: 8, minimumCategories: 6, categoryLimit: 2 }
    : { minimumAccepted: 15, minimumCategories: 8, categoryLimit: 3 };
const macroBatchRules = targetCount => targetCount === 5
  ? { minimumMacroFamilies: 4, macroFamilyLimit: 2 }
  : targetCount === 10
    ? { minimumMacroFamilies: 5, macroFamilyLimit: 3 }
    : { minimumMacroFamilies: 6, macroFamilyLimit: 4 };

function partialContourSimilarity(left, right, predicate) {
  const select = descriptor => new Set([...descriptor.contour].filter(cell => predicate(Number(cell.split(',')[1]))));
  const leftCells = select(left);
  const rightCells = select(right);
  const intersection = [...leftCells].filter(cell => rightCells.has(cell)).length;
  return intersection / (leftCells.size + rightCells.size - intersection || 1);
}

const upperContourSimilarity = (left, right) => partialContourSimilarity(left, right, row => row < 13);
const baseBodyContourSimilarity = (left, right) => partialContourSimilarity(left, right, row => row >= 8 && row < 22);

function selectCrossBatchSubset(candidates, recentScores, minimumCategories, categoryLimit, minimumMacroFamilies, macroFamilyLimit, maximumSize, minimumSize, maximumVisits = Infinity) {
  const upperContours = candidates.map(candidate => new Set([...candidate.descriptor.contour].filter(cell => (
    maximumSize < 10 || Number(cell.split(',')[1]) < 13
  ))));
  const baseBodyContours = candidates.map(candidate => new Set([...candidate.descriptor.contour].filter(cell => {
    const row = Number(cell.split(',')[1]);
    return row >= 8 && row < 22;
  })));
  const contours = upperContours.map((left, leftIndex) => upperContours.map((right, rightIndex) => {
    if (rightIndex <= leftIndex) return 0;
    const intersection = [...left].filter(cell => right.has(cell)).length;
    return intersection / (left.size + right.size - intersection || 1);
  }));
  const baseContours = baseBodyContours.map((left, leftIndex) => baseBodyContours.map((right, rightIndex) => {
    if (rightIndex <= leftIndex) return 0;
    const intersection = [...left].filter(cell => right.has(cell)).length;
    return intersection / (left.size + right.size - intersection || 1);
  }));
  const familyAvailability = Object.groupBy(candidates, candidate => candidate.family);
  const platformAvailability = Object.groupBy(candidates, candidate => candidate.platformType);
  const order = candidates.map((_, index) => index).sort((left, right) => (
    recentScores[left] - recentScores[right]
    || familyAvailability[candidates[left].family].length - familyAvailability[candidates[right].family].length
    || platformAvailability[candidates[left].platformType].length - platformAvailability[candidates[right].platformType].length
  ));
  const smallestSize = Math.max(PLATFORMS.length, minimumSize);
  const largestSize = Math.min(candidates.length, maximumSize);
  const sizes = Array.from({ length: largestSize - smallestSize + 1 }, (_, index) => (
    maximumSize === 20 ? smallestSize + index : largestSize - index
  ));
  let visits = 0;
  let searchExhausted = false;
  for (const size of sizes) {
    const lowestPossibleScore = [...recentScores].sort((left, right) => left - right).slice(0, size)
      .reduce((sum, value) => sum + value, 0);
    if (lowestPossibleScore > size * 0.7) continue;
    const requiredCategories = Math.min(minimumCategories, size);
    const selected = [];
    const platformCounts = new Map();
    const familyCounts = new Map();
    const baseFamilyCounts = new Map();
    const macroFamilyCounts = new Map();
    let samePlatformPairSum = 0;
    let samePlatformPairCount = 0;
    let basePairSum = 0;
    let basePairCount = 0;
    let recentScoreSum = 0;
    const visit = start => {
      visits += 1;
      if (visits > maximumVisits) {
        searchExhausted = true;
        return false;
      }
      if (selected.length === size) {
        if (platformCounts.size !== PLATFORMS.length || familyCounts.size < requiredCategories
          || baseFamilyCounts.size < Math.min(4, size)
          || macroFamilyCounts.size < Math.min(minimumMacroFamilies, size)
          || Math.max(...macroFamilyCounts.values()) > macroFamilyLimit
          || (samePlatformPairCount && samePlatformPairSum / samePlatformPairCount > 0.65)
          || (basePairCount && basePairSum / basePairCount > 0.75)) return false;
        return recentScoreSum / size <= 0.7;
      }
      if (order.length - start < size - selected.length) return false;
      const remainingFamilies = new Set(order.slice(start).map(index => candidates[index].family));
      if (new Set([...familyCounts.keys(), ...remainingFamilies]).size < requiredCategories) return false;
      for (let cursor = start; cursor < order.length; cursor += 1) {
        const index = order[cursor];
        const candidate = candidates[index];
        if ((familyCounts.get(candidate.family) ?? 0) >= categoryLimit
          || (baseFamilyCounts.get(candidate.baseFamily) ?? 0) >= Math.ceil(size / 4)
          || (macroFamilyCounts.get(candidate.macroFamilyKey) ?? 0) >= macroFamilyLimit
          || (platformCounts.get(candidate.platformType) ?? 0) >= Math.floor(size / 2)
          || recentScores[index] > 0.8) continue;
        const samePlatformScores = selected.filter(other => candidates[other].platformType === candidate.platformType)
          .map(other => contours[Math.min(index, other)][Math.max(index, other)]);
        const baseScores = selected.filter(other => candidates[other].platformType === candidate.platformType)
          .map(other => baseContours[Math.min(index, other)][Math.max(index, other)]);
        if (Math.max(0, ...samePlatformScores) > 0.8 || Math.max(0, ...baseScores) > 0.82) continue;
        selected.push(index);
        platformCounts.set(candidate.platformType, (platformCounts.get(candidate.platformType) ?? 0) + 1);
        familyCounts.set(candidate.family, (familyCounts.get(candidate.family) ?? 0) + 1);
        baseFamilyCounts.set(candidate.baseFamily, (baseFamilyCounts.get(candidate.baseFamily) ?? 0) + 1);
        macroFamilyCounts.set(candidate.macroFamilyKey, (macroFamilyCounts.get(candidate.macroFamilyKey) ?? 0) + 1);
        samePlatformPairSum += samePlatformScores.reduce((sum, value) => sum + value, 0);
        samePlatformPairCount += samePlatformScores.length;
        basePairSum += baseScores.reduce((sum, value) => sum + value, 0);
        basePairCount += baseScores.length;
        recentScoreSum += recentScores[index];
        const remainingCount = size - selected.length;
        const lowestRemainingScore = order.slice(cursor + 1).map(other => recentScores[other])
          .sort((left, right) => left - right).slice(0, remainingCount)
          .reduce((sum, value) => sum + value, 0);
        if (recentScoreSum + lowestRemainingScore <= size * 0.7 && visit(cursor + 1)) return true;
        recentScoreSum -= recentScores[index];
        samePlatformPairCount -= samePlatformScores.length;
        samePlatformPairSum -= samePlatformScores.reduce((sum, value) => sum + value, 0);
        basePairCount -= baseScores.length;
        basePairSum -= baseScores.reduce((sum, value) => sum + value, 0);
        platformCounts.set(candidate.platformType, platformCounts.get(candidate.platformType) - 1);
        if (!platformCounts.get(candidate.platformType)) platformCounts.delete(candidate.platformType);
        familyCounts.set(candidate.family, familyCounts.get(candidate.family) - 1);
        if (!familyCounts.get(candidate.family)) familyCounts.delete(candidate.family);
        baseFamilyCounts.set(candidate.baseFamily, baseFamilyCounts.get(candidate.baseFamily) - 1);
        if (!baseFamilyCounts.get(candidate.baseFamily)) baseFamilyCounts.delete(candidate.baseFamily);
        macroFamilyCounts.set(candidate.macroFamilyKey, macroFamilyCounts.get(candidate.macroFamilyKey) - 1);
        if (!macroFamilyCounts.get(candidate.macroFamilyKey)) macroFamilyCounts.delete(candidate.macroFamilyKey);
        selected.pop();
        if (searchExhausted) return false;
      }
      return false;
    };
    if (visit(0)) return selected;
    if (searchExhausted) return [];
  }
  return [];
}

export async function generateLevelBatch({ seed, targetCount = 10, config, assets, existingLevels = [], validateStability, signal, onProgress = () => {}, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)), maxAttempts = Infinity, maxDurationMs = Infinity }) {
  if (![5, 10, 20].includes(targetCount)) throw new RangeError('数量必须为 5、10 或 20');
  const startedAt = performance.now();
  const diagnostics = {
    generatorVersion: GENERATOR_VERSION, attempted: 0, staticPassed: 0, physicsPassed: 0, accepted: 0, elapsedMs: 0, rejected: {},
    duplicateSources: { history: 0, batch: 0, crossBatch: 0 },
    platforms: Object.fromEntries(PLATFORMS.map(platform => [platform, { attempted: 0, accepted: 0 }])),
  };
  const reject = reason => { diagnostics.rejected[reason] = (diagnostics.rejected[reason] ?? 0) + 1; };
  const historicalDescriptors = existingLevels.map(level => ({ id: level.levelNumber ?? level.level?.number, level, descriptor: reconstructLevelStructure(level, assets) }));
  const rarityWeights = historicalRarityWeights(historicalDescriptors.map(entry => entry.descriptor));
  const historicalSignatures = new Set(historicalDescriptors.map(entry => structureSignature(entry.descriptor)));
  const generatedHistoricalDescriptors = historicalDescriptors.filter(entry => (entry.level.castle ?? []).some(object => object.id?.startsWith('generated-')));
  const canonicalHistoricalDescriptors = historicalDescriptors.filter(entry => !generatedHistoricalDescriptors.includes(entry));
  const recentBatchDescriptors = generatedHistoricalDescriptors.slice(-20);
  const recentSimilarity = descriptor => {
    const comparable = recentBatchDescriptors.filter(entry => entry.descriptor.platformType === descriptor.platformType);
    return comparable.length ? Math.max(...comparable.map(entry => (
      upperContourSimilarity(descriptor, entry.descriptor) * 0.55
      + baseBodyContourSimilarity(descriptor, entry.descriptor) * 0.45
    ))) : 0;
  };
  const optimizeCrossBatch = recentBatchDescriptors.length >= 15;
  const maximumRarityWeight = Math.max(...Object.values(rarityWeights));
  const optimizeBatchSubset = targetCount >= 10;
  const candidateLimit = targetCount === 20 ? targetCount + 60
    : targetCount === 10 ? targetCount + 30
    : optimizeBatchSubset || recentBatchDescriptors.length ? targetCount + 4 : targetCount;
  const acceptedDescriptors = [];
  const acceptedRecentScores = [];
  let candidates = [];
  let exactSelectedIndices = null;
  let lastExactSelectionSize = 0;
  let batchSubsetSatisfied = true;
  const topologyCounts = new Map();
  const platformCounts = new Map(PLATFORMS.map(platform => [platform, 0]));
  const platformAttempts = new Map(PLATFORMS.map(platform => [platform, 0]));
  const macroFamilyCounts = new Map(MACRO_FAMILY_KEYS.map(key => [key, 0]));
  const macroFamilyAttempts = new Map(MACRO_FAMILY_KEYS.map(key => [key, 0]));
  const macroOrderRandom = createDeterministicRandom(`${seed}:macro-family-order:${targetCount}`);
  const macroOffset = Math.floor(macroOrderRandom() * MACRO_FAMILY_KEYS.length);
  const macroOrder = [...MACRO_FAMILY_KEYS.slice(macroOffset), ...MACRO_FAMILY_KEYS.slice(0, macroOffset)];
  const { minimumMacroFamilies, macroFamilyLimit } = macroBatchRules(targetCount);
  diagnostics.macroFamilies = {
    minimum: minimumMacroFamilies,
    limit: macroFamilyLimit,
    accepted: Object.fromEntries(macroFamilyCounts),
  };
  let lastPhysicalFailurePlatform = null;
  let deferUncoveredPlatform = false;
  const random = createDeterministicRandom(`${seed}:batch-order:${targetCount}`);
  const platformOffset = Math.floor(random() * PLATFORMS.length);
  const explorationOffset = optimizeCrossBatch || optimizeBatchSubset ? 1 + Math.floor(random() * 7) : 0;
  const platformOrder = [...PLATFORMS.slice(platformOffset), ...PLATFORMS.slice(0, platformOffset)];
  const { minimumAccepted, minimumCategories, categoryLimit } = batchRules(targetCount);
  const highestExisting = Math.max(0, ...existingLevels.map(level => Number(level.levelNumber ?? level.level?.number ?? 0)).filter(Number.isFinite));
  const baseNumber = Math.max(100, highestExisting + 1);
  for (let attempt = 0; attempt < maxAttempts && candidates.length < candidateLimit; attempt += 1) {
    if (signal?.aborted) { reject('cancelled'); break; }
    if (performance.now() - startedAt >= maxDurationMs) { reject('performance'); break; }
    diagnostics.attempted += 1;
    const uncovered = platformOrder.filter(platform => platformCounts.get(platform) === 0);
    const platformAllowance = (candidates.length + 1) / 2;
    let eligible;
    if (uncovered.length) {
      const fewestAttempts = Math.min(...uncovered.map(platform => platformAttempts.get(platform)));
      eligible = uncovered.filter(platform => platformAttempts.get(platform) === fewestAttempts);
      if ((targetCount === 20 || eligible.length === 1) && fewestAttempts >= 8 && deferUncoveredPlatform
        && (targetCount === 20 || candidates.length + uncovered.length + 1 < candidateLimit
          || (targetCount === 5 && candidates.length + uncovered.length + 1 === candidateLimit))) {
        const alternatives = platformOrder.filter(platform => !uncovered.includes(platform)
          && platformCounts.get(platform) + 1 <= platformAllowance)
          .sort((left, right) => platformAttempts.get(left) - platformAttempts.get(right));
        const alternative = alternatives[0];
        if (alternative) {
          eligible = [alternative];
          deferUncoveredPlatform = false;
        }
      } else if ((targetCount === 20 || eligible.length === 1) && fewestAttempts >= 8) {
        deferUncoveredPlatform = true;
      }
    } else {
      eligible = platformOrder.filter(platform => platformCounts.get(platform) + 1 <= platformAllowance);
      eligible.sort((left, right) => optimizeBatchSubset
        ? platformAttempts.get(left) - platformAttempts.get(right)
        : platformCounts.get(right) / platformAttempts.get(right) - platformCounts.get(left) / platformAttempts.get(left));
      if (eligible.length > 1 && eligible[0] === lastPhysicalFailurePlatform) {
        eligible.push(eligible.shift());
        lastPhysicalFailurePlatform = null;
      }
    }
    const platformType = eligible[0];
    const platformAttempt = platformAttempts.get(platformType);
    const candidateAttempt = platformAttempt;
    const familyIndex = platformAttempt * (optimizeCrossBatch ? 7 : 1)
      + (!optimizeCrossBatch && !optimizeBatchSubset ? PLATFORMS.indexOf(platformType) * 2 : 0)
      + (platformAttempt % 4 === 0 ? explorationOffset : 0);
    let candidateFamilyIndex = familyIndex;
    const macroFamilyKey = [...macroOrder]
      .filter(key => macroFamilyCounts.get(key) < macroFamilyLimit
        && (targetCount === 20 || macroFamilyAttempts.get(key) < (macroFamilyCounts.get(key) + 1) * 32))
      .sort((left, right) => (
        macroFamilyCounts.get(left) + Math.floor(macroFamilyAttempts.get(left) / 12)
          - macroFamilyCounts.get(right) - Math.floor(macroFamilyAttempts.get(right) / 12)
        || macroFamilyAttempts.get(left) - macroFamilyAttempts.get(right)
        || macroOrder.indexOf(left) - macroOrder.indexOf(right)
      ))[0];
    if (!macroFamilyKey) break;
    macroFamilyAttempts.set(macroFamilyKey, macroFamilyAttempts.get(macroFamilyKey) + 1);
    const attemptRarityWeights = optimizeCrossBatch || optimizeBatchSubset ? {
      ...Object.fromEntries(Object.entries(rarityWeights).map(([operation, weight]) => (
        [operation, optimizeCrossBatch ? weight / Math.sqrt(maximumRarityWeight)
          : weight * historicalRarityWeights(acceptedDescriptors.map(entry => entry.descriptor))[operation]]
      ))),
      crossBatch: optimizeCrossBatch,
      batchMode: true,
      compactWing: !optimizeCrossBatch,
    } : { ...rarityWeights, batchMode: true, compactWing: true };
    platformAttempts.set(platformType, platformAttempt + 1);
    diagnostics.platforms[platformType].attempted += 1;
    const structuralShape = targetCount === 20
      ? (platformAttempt % 2 ? 'isosceles-triangle' : 'circle')
      : candidates.length === 0 ? 'circle' : candidates.length === 1 || platformAttempt % 2 ? 'isosceles-triangle' : 'circle';
    const localRetry = candidates.length >= 9 && candidates.length < 13 ? LOCAL_RETRY_OFFSETS.length : 0;
    let candidate;
    try {
      candidate = buildGeneratedCandidate({
        seed, attempt: candidateAttempt, number: baseNumber + candidates.length, platformType, familyIndex: candidateFamilyIndex, macroFamilyKey, assets, rarityWeights: attemptRarityWeights, budgetExponent: 3, preserveParallelRatio: 0.35, terminationRatio: 0.75, adaptiveConnections: true, wideStructuralFallback: true, randomizeCross: true, shiftFamilyOnRetry: false,
        structuralShape, localRetry,
      });
    }
    catch (error) { if (error.code === 'CONFIG_INVALID') throw error; reject('complexity'); continue; }
    let staticResult = validateGeneratedCandidate(candidate, { assets, knownSignatures: historicalSignatures, knownDescriptors: canonicalHistoricalDescriptors, reconstructedDescriptor: candidate.descriptor });
    let recentScore = staticResult.ok ? recentSimilarity(staticResult.descriptor) : 0;
    if (optimizeCrossBatch && (staticResult.reason === 'duplicate' || (staticResult.ok && recentScore > 0.75))) try {
      const alternateFamilyIndex = familyIndex + 4 * (1 + platformAttempt % 4);
      const alternate = buildGeneratedCandidate({
        seed, attempt: candidateAttempt, number: baseNumber + candidates.length, platformType, familyIndex: alternateFamilyIndex, macroFamilyKey,
        assets, rarityWeights: attemptRarityWeights, budgetExponent: 3, preserveParallelRatio: 0.35, terminationRatio: 0.75, adaptiveConnections: true, wideStructuralFallback: true, randomizeCross: true, shiftFamilyOnRetry: false, structuralShape, localRetry,
      });
      const alternateResult = validateGeneratedCandidate(alternate, {
        assets, knownSignatures: historicalSignatures, knownDescriptors: canonicalHistoricalDescriptors, reconstructedDescriptor: alternate.descriptor,
      });
      const alternateScore = alternateResult.ok ? recentSimilarity(alternateResult.descriptor) : 1;
      if (alternateResult.ok && (!staticResult.ok || alternateScore <= recentScore - 0.03)) {
        candidate = alternate;
        candidateFamilyIndex = alternateFamilyIndex;
        staticResult = alternateResult;
        recentScore = alternateScore;
      }
    } catch {}
    const batchDuplicateIndexes = staticResult.ok ? acceptedDescriptors.map((entry, index) => ({
      index, comparison: isNearDuplicate(staticResult.descriptor, entry.descriptor),
      exact: staticResult.signature === candidates[index].signature,
    })).filter(entry => entry.exact || (!optimizeBatchSubset && entry.comparison.duplicate)).map(entry => entry.index) : [];
    const saturatedReplacementIndex = staticResult.ok && optimizeCrossBatch
      && (topologyCounts.get(staticResult.descriptor.topologyKey) ?? 0) >= categoryLimit
      ? candidates.map((value, index) => ({ index, value })).filter(({ index, value }) => value.family === staticResult.descriptor.topologyKey
        && value.platformType === platformType && acceptedRecentScores[index] > recentScore)
        .sort((left, right) => acceptedRecentScores[right.index] - acceptedRecentScores[left.index])[0]?.index : undefined;
    if (batchDuplicateIndexes.length || saturatedReplacementIndex !== undefined) {
      diagnostics.duplicateSources.batch += 1;
      const replacementIndex = saturatedReplacementIndex ?? (targetCount === 20 ? batchDuplicateIndexes.find(index => acceptedDescriptors[index].platformType === platformType
        && ((!topologyCounts.has(staticResult.descriptor.topologyKey) && (topologyCounts.get(candidates[index].family) ?? 0) > 1)
          || (recentBatchDescriptors.length && candidates[index].family === staticResult.descriptor.topologyKey
            && recentScore < acceptedRecentScores[index]))
        && (!recentBatchDescriptors.length || recentScore <= 0.8)) : undefined);
      const otherDescriptors = acceptedDescriptors.filter((_, index) => index !== replacementIndex);
      const otherSignatures = new Set([...historicalSignatures, ...candidates.filter((_, index) => index !== replacementIndex).map(value => value.signature)]);
      const replacementResult = replacementIndex === undefined ? null : validateGeneratedCandidate(candidate, {
        assets, knownSignatures: otherSignatures, knownDescriptors: [...canonicalHistoricalDescriptors, ...otherDescriptors], reconstructedDescriptor: candidate.descriptor,
      });
      const replacementGroup = replacementResult?.ok
        ? [...otherDescriptors.filter(entry => entry.platformType === platformType).map(entry => entry.descriptor), replacementResult.descriptor] : [];
      const replacementPairs = replacementGroup.flatMap((left, index) => replacementGroup.slice(index + 1).map(right => compareStructureDescriptors(left, right).contourJaccard));
      const replacementAverage = replacementPairs.length ? replacementPairs.reduce((sum, value) => sum + value, 0) / replacementPairs.length : 0;
      if (replacementResult?.ok && replacementAverage <= 0.65 && Math.max(0, ...replacementPairs) <= 0.8) {
        const old = candidates[replacementIndex];
        candidate = buildGeneratedCandidate({
          seed, attempt: candidateAttempt, number: old.level.levelNumber, platformType, familyIndex: candidateFamilyIndex, macroFamilyKey, assets, rarityWeights: attemptRarityWeights, budgetExponent: 3, preserveParallelRatio: 0.35, terminationRatio: 0.75, adaptiveConnections: true, wideStructuralFallback: true, randomizeCross: true, shiftFamilyOnRetry: false, structuralShape, localRetry,
        });
        staticResult = validateGeneratedCandidate(candidate, {
          assets, knownSignatures: otherSignatures, knownDescriptors: [...canonicalHistoricalDescriptors, ...otherDescriptors], reconstructedDescriptor: candidate.descriptor,
        });
        if (!staticResult.ok) {
          reject(staticResult.reason);
          diagnostics.elapsedMs = performance.now() - startedAt;
          onProgress(clone(diagnostics));
          if (attempt % 8 === 7) await yieldControl();
          continue;
        }
        diagnostics.staticPassed += 1;
        const stability = await validateStability(candidate.level, { config, assets, signal });
        if (!stability.ok) {
          lastPhysicalFailurePlatform = platformType; reject(stability.reason);
        }
        else {
          lastPhysicalFailurePlatform = null;
          diagnostics.physicsPassed += 1;
          candidate = { ...candidate, signature: staticResult.signature, descriptor: staticResult.descriptor, metrics: staticResult.metrics, nearest: staticResult.nearest, stability };
          candidates[replacementIndex] = candidate;
          acceptedDescriptors[replacementIndex] = { id: candidate.level.levelNumber, level: candidate.level, platformType, descriptor: candidate.descriptor };
          acceptedRecentScores[replacementIndex] = recentScore;
          topologyCounts.set(old.family, topologyCounts.get(old.family) - 1);
          if (!topologyCounts.get(old.family)) topologyCounts.delete(old.family);
          topologyCounts.set(candidate.family, (topologyCounts.get(candidate.family) ?? 0) + 1);
          macroFamilyCounts.set(old.macroFamilyKey, macroFamilyCounts.get(old.macroFamilyKey) - 1);
          macroFamilyCounts.set(candidate.macroFamilyKey, macroFamilyCounts.get(candidate.macroFamilyKey) + 1);
          diagnostics.macroFamilies.accepted = Object.fromEntries(macroFamilyCounts);
        }
      } else reject('duplicate');
      diagnostics.elapsedMs = performance.now() - startedAt;
      onProgress(clone(diagnostics));
      if (attempt % 8 === 7) await yieldControl();
      continue;
    }
    const samePlatform = acceptedDescriptors.filter(entry => entry.platformType === platformType);
    const projectedGroup = staticResult.ok ? [...samePlatform.map(entry => entry.descriptor), staticResult.descriptor] : [];
    const contourPairs = projectedGroup.flatMap((left, index) => projectedGroup.slice(index + 1).map(right => compareStructureDescriptors(left, right).contourJaccard));
    const projectedContourAverage = contourPairs.length ? contourPairs.reduce((sum, value) => sum + value, 0) / contourPairs.length : 0;
    if (!staticResult.ok) {
      if (staticResult.reason === 'duplicate') diagnostics.duplicateSources.history += 1;
      reject(staticResult.reason);
    }
    else if (!optimizeBatchSubset && (projectedContourAverage > 0.65 || Math.max(0, ...contourPairs) > 0.8)) reject('diversity');
    else if (recentBatchDescriptors.length && recentScore > 0.8) {
      diagnostics.duplicateSources.crossBatch += 1;
      reject('duplicate');
    }
    else if (!optimizeBatchSubset && (topologyCounts.get(staticResult.descriptor.topologyKey) ?? 0) >= categoryLimit) reject('diversity');
    else if (topologyCounts.size + Number(!topologyCounts.has(staticResult.descriptor.topologyKey)) + candidateLimit - candidates.length - 1 < minimumCategories) reject('diversity');
    else {
      diagnostics.staticPassed += 1;
      let stability = await validateStability(candidate.level, { config, assets, signal });
      if (!stability.ok) {
        reject(stability.reason);
        if (!topologyCounts.has(staticResult.descriptor.topologyKey)) try {
          const alternateShape = structuralShape === 'circle' ? 'isosceles-triangle' : 'circle';
          const alternate = buildGeneratedCandidate({
            seed, attempt: candidateAttempt, number: baseNumber + candidates.length, platformType, familyIndex: candidateFamilyIndex + 4, macroFamilyKey, assets, rarityWeights: attemptRarityWeights, budgetExponent: 3, preserveParallelRatio: 0.35, terminationRatio: 0.75, adaptiveConnections: true, wideStructuralFallback: true, randomizeCross: true, shiftFamilyOnRetry: false,
            structuralShape: alternateShape, localRetry,
          });
          const alternateResult = validateGeneratedCandidate(alternate, {
            assets,
            knownSignatures: new Set([...historicalSignatures, ...candidates.map(value => value.signature)]),
            knownDescriptors: [...canonicalHistoricalDescriptors, ...acceptedDescriptors],
            reconstructedDescriptor: alternate.descriptor,
          });
          const alternateGroup = alternateResult.ok ? [...samePlatform.map(entry => entry.descriptor), alternateResult.descriptor] : [];
          const alternatePairs = alternateGroup.flatMap((left, index) => alternateGroup.slice(index + 1).map(right => compareStructureDescriptors(left, right).contourJaccard));
          const alternateAverage = alternatePairs.length ? alternatePairs.reduce((sum, value) => sum + value, 0) / alternatePairs.length : 0;
          const alternateRecentScore = alternateResult.ok ? recentSimilarity(alternateResult.descriptor) : 0;
          if (alternateResult.ok && alternateAverage <= 0.65 && Math.max(0, ...alternatePairs) <= 0.8
            && alternateRecentScore <= 0.8 && (topologyCounts.get(alternateResult.descriptor.topologyKey) ?? 0) < categoryLimit) {
            diagnostics.staticPassed += 1;
            const alternateStability = await validateStability(alternate.level, { config, assets, signal });
            if (alternateStability.ok) {
              candidate = alternate;
              staticResult = alternateResult;
              recentScore = alternateRecentScore;
              stability = alternateStability;
            } else reject(alternateStability.reason);
          }
        } catch {}
      }
      if (!stability.ok) {
        lastPhysicalFailurePlatform = platformType;
      }
      else {
        lastPhysicalFailurePlatform = null;
        diagnostics.physicsPassed += 1;
        candidate = { ...candidate, signature: staticResult.signature, descriptor: staticResult.descriptor, metrics: staticResult.metrics, nearest: staticResult.nearest, stability };
        acceptedDescriptors.push({ id: candidate.level.levelNumber, level: candidate.level, platformType, descriptor: candidate.descriptor });
        acceptedRecentScores.push(recentScore);
        candidates.push(candidate);
        topologyCounts.set(candidate.family, (topologyCounts.get(candidate.family) ?? 0) + 1);
        platformCounts.set(platformType, platformCounts.get(platformType) + 1);
        macroFamilyCounts.set(candidate.macroFamilyKey, macroFamilyCounts.get(candidate.macroFamilyKey) + 1);
        diagnostics.macroFamilies.accepted = Object.fromEntries(macroFamilyCounts);
        diagnostics.platforms[platformType].accepted += 1;
        diagnostics.accepted = candidates.length;
      }
    }
    diagnostics.elapsedMs = performance.now() - startedAt;
    onProgress(clone(diagnostics));
    const shouldCheckExactSelection = candidates.length === targetCount
      || candidates.length >= targetCount + 4 && candidates.length - lastExactSelectionSize >= 4;
    if (!signal?.aborted && shouldCheckExactSelection) {
      lastExactSelectionSize = candidates.length;
      const selected = selectCrossBatchSubset(
        candidates, acceptedRecentScores, minimumCategories, categoryLimit,
        minimumMacroFamilies, macroFamilyLimit, targetCount, targetCount, 50_000,
      );
      if (selected.length === targetCount) {
        exactSelectedIndices = selected;
        break;
      }
    }
    if (attempt % 8 === 7) await yieldControl();
  }
  if ((optimizeBatchSubset || recentBatchDescriptors.length) && candidates.length) {
    const poolScores = [...acceptedRecentScores];
    const poolCategories = new Set(candidates.map(candidate => candidate.family)).size;
    const selected = signal?.aborted ? [] : exactSelectedIndices ?? selectCrossBatchSubset(
      candidates, acceptedRecentScores, minimumCategories, categoryLimit,
      minimumMacroFamilies, macroFamilyLimit, targetCount, minimumAccepted,
    );
    const selectedIndices = selected.length ? selected : candidates.slice(0, targetCount).map((_, index) => index);
    batchSubsetSatisfied = selected.length > 0;
    diagnostics.crossBatchPool = {
      candidates: candidates.length,
      categories: poolCategories,
      families: Object.fromEntries(Object.entries(Object.groupBy(candidates, candidate => candidate.family)).map(([family, values]) => [family, values.length])),
      platforms: Object.fromEntries(Object.entries(Object.groupBy(candidates, candidate => candidate.platformType)).map(([platform, values]) => [platform, values.length])),
      scoreAverage: poolScores.reduce((sum, value) => sum + value, 0) / poolScores.length,
      scoreMinimum: Math.min(...poolScores),
      scoreMaximum: Math.max(...poolScores),
      entries: candidates.map((candidate, index) => ({
        index, platform: candidate.platformType, family: candidate.family, baseFamily: candidate.baseFamily,
        macroFamilyKey: candidate.macroFamilyKey, score: poolScores[index],
      })),
      selected: selectedIndices.length,
      selectedIndices,
      selectionSatisfied: batchSubsetSatisfied,
    };
    candidates = selectedIndices.map(index => candidates[index]);
    diagnostics.accepted = candidates.length;
    for (const platform of PLATFORMS) {
      const count = candidates.filter(candidate => candidate.platformType === platform).length;
      platformCounts.set(platform, count);
      diagnostics.platforms[platform].accepted = count;
    }
    for (const key of MACRO_FAMILY_KEYS) macroFamilyCounts.set(key, candidates.filter(candidate => candidate.macroFamilyKey === key).length);
    diagnostics.macroFamilies.accepted = Object.fromEntries(macroFamilyCounts);
  }
  if (diagnostics.attempted >= maxAttempts && candidates.length < targetCount) reject('attempts');
  const categoryCount = new Set(candidates.map(candidate => candidate.family)).size;
  const missingPlatforms = PLATFORMS.filter(platform => platformCounts.get(platform) === 0);
  const maximumPlatformCount = Math.max(...platformCounts.values());
  const macroFamilyCount = new Set(candidates.map(candidate => candidate.macroFamilyKey)).size;
  const maximumMacroFamilyCount = Math.max(0, ...Object.values(Object.groupBy(
    candidates, candidate => candidate.macroFamilyKey,
  )).map(group => group.length));
  const insufficient = !signal?.aborted && (!batchSubsetSatisfied || candidates.length < minimumAccepted || categoryCount < minimumCategories
    || missingPlatforms.length > 0 || maximumPlatformCount > candidates.length / 2
    || macroFamilyCount < minimumMacroFamilies || maximumMacroFamilyCount > macroFamilyLimit);
  diagnostics.insufficient = insufficient;
  if (insufficient) diagnostics.shortfall = {
    requested: targetCount, accepted: candidates.length, minimumAccepted, categories: categoryCount, minimumCategories,
    missingPlatforms, maximumPlatformCount, maximumPlatformAllowed: Math.floor(candidates.length / 2),
    macroFamilyCount, minimumMacroFamilies, maximumMacroFamilyCount, macroFamilyLimit,
  };
  diagnostics.elapsedMs = performance.now() - startedAt;
  return { seed, generatorVersion: GENERATOR_VERSION, targetCount, candidates, diagnostics, cancelled: Boolean(signal?.aborted), insufficient };
}
