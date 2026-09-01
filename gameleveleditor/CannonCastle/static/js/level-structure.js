import { environmentSupports, objectBounds, placementConstants, rotatedVertices, shapeIntersectsBounds } from './placement-collision.js';

export const STRUCTURE_DESCRIPTOR_VERSION = 2;
const GRID_SIZE = 32;
const MACRO_BAND_COUNT = 6;

const shapeOf = (object, assets) => object.shape ?? assets?.shapes?.[object.shapePresetId]?.shape;
const overlap = (left, right) => Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX);

function roleOf(object) {
  if (object.shape.kind === 'circle') return 'round';
  if (object.shape.kind !== 'box') return 'brace';
  const bounds = objectBounds(object);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width >= height * 2.4) return 'beam';
  if (height >= width * 1.8) return 'post';
  return 'block';
}

const isConnector = object => roleOf(object) === 'beam' || object.shape.kind !== 'box';

function inferGraph(level, assets) {
  const objects = (level.castle ?? []).map(object => ({ ...object, shape: shapeOf(object, assets) })).filter(object => object.shape);
  const bounds = objects.map(objectBounds);
  const parents = objects.map(() => []);
  const rootIndices = [];
  const rootRegions = objects.map(() => new Set());
  const platforms = environmentSupports({ platformType: level.platformType });
  for (let child = 0; child < objects.length; child += 1) {
    const childBounds = bounds[child];
    const platformSeam = childBounds.maxY - placementConstants.PLATFORM_TOP_Y;
    if (platformSeam >= -placementConstants.SUPPORT_CONTACT_TOLERANCE && platformSeam <= placementConstants.SUPPORT_MAX_EMBED) {
      platforms.forEach((platform, region) => {
        if (overlap(childBounds, { minX: platform.centerX - platform.width / 2, maxX: platform.centerX + platform.width / 2 }) >= placementConstants.SUPPORT_MIN_OVERLAP) rootRegions[child].add(region);
      });
      if (rootRegions[child].size) rootIndices.push(child);
    }
    for (let parent = 0; parent < objects.length; parent += 1) {
      if (child === parent || objects[parent].y <= objects[child].y) continue;
      const seam = childBounds.maxY - bounds[parent].minY;
      if (seam >= -placementConstants.SUPPORT_CONTACT_TOLERANCE && seam <= placementConstants.SUPPORT_MAX_EMBED
        && overlap(childBounds, bounds[parent]) >= placementConstants.SUPPORT_MIN_OVERLAP) parents[child].push(parent);
    }
    parents[child].sort((left, right) => objects[left].x - objects[right].x || left - right);
  }
  const roots = new Set(rootIndices);
  const depths = new Map();
  const depthOf = (index, seen = new Set()) => {
    if (depths.has(index)) return depths.get(index);
    if (seen.has(index)) return -Infinity;
    const depth = roots.has(index) ? 1 : parents[index].length
      ? 1 + Math.max(...parents[index].map(parent => depthOf(parent, new Set([...seen, index]))))
      : 0;
    depths.set(index, depth);
    return depth;
  };
  objects.forEach((_, index) => depthOf(index));
  const relativeDepths = new Map();
  const relativeDepthOf = (index, seen = new Set()) => {
    if (relativeDepths.has(index)) return relativeDepths.get(index);
    if (seen.has(index)) return 0;
    const depth = parents[index].length ? 1 + Math.max(...parents[index].map(parent => relativeDepthOf(parent, new Set([...seen, index])))) : 1;
    relativeDepths.set(index, depth);
    return depth;
  };
  objects.forEach((_, index) => relativeDepthOf(index));
  const children = objects.map(() => []);
  parents.forEach((values, child) => values.forEach(parent => children[parent].push(child)));
  const propagatedRegions = new Map();
  const regionsOf = (index, seen = new Set()) => {
    if (propagatedRegions.has(index)) return propagatedRegions.get(index);
    if (seen.has(index)) return new Set();
    const regions = new Set(rootRegions[index]);
    for (const parent of parents[index]) for (const region of regionsOf(parent, new Set([...seen, index]))) regions.add(region);
    propagatedRegions.set(index, regions);
    return regions;
  };
  objects.forEach((_, index) => regionsOf(index));
  return { objects, bounds, parents, children, rootIndices, rootRegions, platforms, depths, relativeDepths, propagatedRegions, platformRegionCount: platforms.length, maxDepth: Math.max(0, ...depths.values()), relativeMaxDepth: Math.max(0, ...relativeDepths.values()) };
}

function componentSizes(graph) {
  const neighbors = graph.objects.map(() => new Set());
  graph.parents.forEach((parents, child) => parents.forEach(parent => {
    neighbors[child].add(parent);
    neighbors[parent].add(child);
  }));
  const remaining = new Set(graph.objects.map((_, index) => index));
  const sizes = [];
  while (remaining.size) {
    const queue = [remaining.values().next().value];
    remaining.delete(queue[0]);
    let size = 0;
    while (queue.length) {
      const index = queue.pop();
      size += 1;
      for (const neighbor of neighbors[index]) if (remaining.delete(neighbor)) queue.push(neighbor);
    }
    sizes.push(size);
  }
  return sizes.sort((left, right) => right - left);
}

function gridFor(graph, mirrored) {
  if (!graph.objects.length) return { contour: new Set(), whitespace: new Set() };
  const minX = Math.min(...graph.bounds.map(value => value.minX));
  const maxX = Math.max(...graph.bounds.map(value => value.maxX));
  const minY = Math.min(...graph.bounds.map(value => value.minY));
  const maxY = Math.max(...graph.bounds.map(value => value.maxY));
  const width = Math.max(0.01, maxX - minX);
  const height = Math.max(0.01, maxY - minY);
  const contour = new Set();
  const vertices = graph.objects.map(rotatedVertices);
  for (let index = 0; index < graph.bounds.length; index += 1) {
    const bounds = graph.bounds[index];
    const firstX = Math.max(0, Math.floor((bounds.minX - minX) / width * GRID_SIZE));
    const lastX = Math.min(GRID_SIZE - 1, Math.ceil((bounds.maxX - minX) / width * GRID_SIZE) - 1);
    const firstY = Math.max(0, Math.floor((bounds.minY - minY) / height * GRID_SIZE));
    const lastY = Math.min(GRID_SIZE - 1, Math.ceil((bounds.maxY - minY) / height * GRID_SIZE) - 1);
    for (let y = firstY; y <= lastY; y += 1) for (let x = firstX; x <= lastX; x += 1) {
      const cell = { minX: minX + x / GRID_SIZE * width, maxX: minX + (x + 1) / GRID_SIZE * width, minY: minY + y / GRID_SIZE * height, maxY: minY + (y + 1) / GRID_SIZE * height };
      if (shapeIntersectsBounds(graph.objects[index], cell, vertices[index])) contour.add(`${mirrored ? GRID_SIZE - 1 - x : x},${y}`);
    }
  }
  const whitespace = new Set();
  const rowMin = Array(GRID_SIZE).fill(Infinity);
  const rowMax = Array(GRID_SIZE).fill(-Infinity);
  const columnMin = Array(GRID_SIZE).fill(Infinity);
  for (const value of contour) {
    const [x, y] = value.split(',').map(Number);
    rowMin[y] = Math.min(rowMin[y], x);
    rowMax[y] = Math.max(rowMax[y], x);
    columnMin[x] = Math.min(columnMin[x], y);
  }
  for (let y = 1; y < GRID_SIZE - 1; y += 1) for (let x = 1; x < GRID_SIZE - 1; x += 1) {
    if (contour.has(`${x},${y}`)) continue;
    if (rowMin[y] < x && rowMax[y] > x && columnMin[x] < y) whitespace.add(`${x},${y}`);
  }
  return { contour, whitespace };
}

const setKey = values => [...values].sort().join('|');

function canonicalGrid(graph) {
  const normal = gridFor(graph, false);
  const mirrorSet = values => new Set([...values].map(value => {
    const [x, y] = value.split(',');
    return `${GRID_SIZE - 1 - Number(x)},${y}`;
  }));
  const mirror = { contour: mirrorSet(normal.contour), whitespace: mirrorSet(normal.whitespace) };
  return setKey(normal.contour) <= setKey(mirror.contour) ? normal : mirror;
}

function mergedSpan(intervals, maximumGap = 0.21) {
  const ordered = intervals.filter(interval => interval.maxX > interval.minX)
    .sort((left, right) => left.minX - right.minX || left.maxX - right.maxX);
  let maximum = 0;
  let current = null;
  for (const interval of ordered) {
    if (!current || interval.minX - current.maxX > maximumGap) {
      current = { ...interval };
    } else {
      current.maxX = Math.max(current.maxX, interval.maxX);
    }
    maximum = Math.max(maximum, current.maxX - current.minX);
  }
  return maximum;
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

function macroProfileFor(graph) {
  if (!graph.objects.length) return [];

  const minX = Math.min(...graph.bounds.map(bounds => bounds.minX));
  const maxX = Math.max(...graph.bounds.map(bounds => bounds.maxX));
  const minY = Math.min(...graph.bounds.map(bounds => bounds.minY));
  const maxY = Math.max(...graph.bounds.map(bounds => bounds.maxY));
  const width = Math.max(0.01, maxX - minX);
  const height = Math.max(0.01, maxY - minY);
  const sceneCenter = (minX + maxX) / 2;
  const raw = [];

  for (let band = 0; band < MACRO_BAND_COUNT; band += 1) {
    const bandMaxY = maxY - band / MACRO_BAND_COUNT * height;
    const bandMinY = maxY - (band + 1) / MACRO_BAND_COUNT * height;
    const intervals = graph.bounds
      .filter(bounds => bounds.maxY > bandMinY && bounds.minY < bandMaxY)
      .map(bounds => [bounds.minX, bounds.maxX]);
    const spans = mergeMacroIntervals(intervals, width * 0.04);

    if (!spans.length) {
      raw.push({
        spanCount: 0,
        envelopeWidth: 0,
        largestSpanWidth: 0,
        centerOffset: 0,
        voidCount: 0,
        centerVoid: false,
      });
      continue;
    }

    const occupied = spans.reduce((sum, span) => sum + span[1] - span[0], 0);
    const center = spans.reduce((sum, span) => (
      sum + (span[0] + span[1]) / 2 * (span[1] - span[0])
    ), 0) / Math.max(occupied, Number.EPSILON);
    const gaps = spans.slice(0, -1).map((span, index) => ({
      minX: span[1],
      maxX: spans[index + 1][0],
    })).filter(gap => gap.maxX - gap.minX >= width * 0.08);

    raw.push({
      spanCount: spans.length,
      envelopeWidth: (spans.at(-1)[1] - spans[0][0]) / width,
      largestSpanWidth: Math.max(...spans.map(span => span[1] - span[0])) / width,
      centerOffset: (center - sceneCenter) / width,
      voidCount: gaps.length,
      centerVoid: gaps.some(gap => gap.minX < sceneCenter && gap.maxX > sceneCenter),
    });
  }

  const firstOffset = raw.find(value => Math.abs(value.centerOffset) >= 0.04)?.centerOffset ?? 1;
  const direction = firstOffset < 0 ? -1 : 1;
  return raw.map(value => ({
    ...value,
    centerOffset: Number((value.centerOffset * direction).toFixed(3)),
  }));
}

function macroFingerprintFor(profile) {
  return profile.map(value => [
    Math.min(3, value.spanCount),
    Math.round(value.envelopeWidth * 5),
    Math.round(value.largestSpanWidth * 5),
    Math.round(value.centerOffset * 8),
    Number(value.centerVoid),
    Math.min(3, value.voidCount),
  ].join(':')).join('|');
}

function architectureMetrics(graph, grid) {
  if (!graph.objects.length) return {
    foundationContinuity: 0,
    majorBandCount: 0,
    lowerCohesion: 0,
    maxDensePostRun: 0,
  };
  const foundationContinuity = Math.min(...graph.platforms.map((platform, region) => {
    const platformMin = platform.centerX - platform.width / 2;
    const platformMax = platform.centerX + platform.width / 2;
    const intervals = graph.rootIndices.filter(index => graph.rootRegions[index].has(region)).map(index => ({
      minX: Math.max(platformMin, graph.bounds[index].minX),
      maxX: Math.min(platformMax, graph.bounds[index].maxX),
    }));
    return mergedSpan(intervals) / platform.width;
  }));

  const bodyMinX = Math.min(...graph.bounds.map(bounds => bounds.minX));
  const bodyMaxX = Math.max(...graph.bounds.map(bounds => bounds.maxX));
  const majorBandThreshold = Math.min(2, (bodyMaxX - bodyMinX) * 0.45);
  const beamLayers = [];
  graph.objects.forEach((object, index) => {
    if (roleOf(object) !== 'beam') return;
    let layer = beamLayers.find(value => Math.abs(value.y - object.y) <= 0.12);
    if (!layer) {
      layer = { y: object.y, intervals: [] };
      beamLayers.push(layer);
    }
    layer.intervals.push(graph.bounds[index]);
  });
  const majorBandCount = beamLayers.filter(layer => mergedSpan(layer.intervals) >= majorBandThreshold).length;

  const lowerRows = Array.from({ length: GRID_SIZE - Math.floor(GRID_SIZE * 0.6) },
    (_, index) => Math.floor(GRID_SIZE * 0.6) + index);
  const lowerCohesion = lowerRows.reduce((sum, y) => {
    const occupied = [...grid.contour].map(value => value.split(',').map(Number))
      .filter(([, row]) => row === y).map(([x]) => x).sort((left, right) => left - right);
    let longest = 0;
    let start = null;
    let previous = null;
    for (const x of occupied) {
      if (start === null || x - previous > 2) start = x;
      longest = Math.max(longest, x - start + 1);
      previous = x;
    }
    return sum + longest / GRID_SIZE;
  }, 0) / lowerRows.length;

  const postLayers = [];
  graph.objects.filter(object => object.shapePresetId === 'short-thin-rectangle' && roleOf(object) === 'post')
    .sort((left, right) => left.y - right.y || left.x - right.x).forEach(object => {
      let layer = postLayers.find(value => Math.abs(value.y - object.y) <= 0.02);
      if (!layer) {
        layer = { y: object.y, xs: [] };
        postLayers.push(layer);
      }
      layer.xs.push(object.x);
    });
  const maxDensePostRun = Math.max(0, ...postLayers.map(layer => {
    const xs = layer.xs.sort((left, right) => left - right);
    let longest = xs.length ? 1 : 0;
    let run = longest;
    for (let index = 1; index < xs.length; index += 1) {
      run = xs[index] - xs[index - 1] <= 0.23 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    return longest;
  }));

  return { foundationContinuity, majorBandCount, lowerCohesion, maxDensePostRun };
}

function supportSignatureFor(graph, mirrored) {
  if (!graph.objects.length) return 'empty';
  const roundedX = graph.objects.map(object => Math.round(object.x * 100) / 100);
  const minX = Math.min(...roundedX);
  const maxX = Math.max(...roundedX);
  const width = Math.max(0.01, maxX - minX);
  const normalizedX = index => (mirrored ? maxX - roundedX[index] : roundedX[index] - minX) / width;
  const nodes = graph.objects.map((object, index) => [graph.relativeDepths.get(index), roleOf(object), Math.round(normalizedX(index) * 8), graph.parents[index].length, graph.children[index].length].join(':')).sort();
  const edges = graph.parents.flatMap((parents, child) => parents.map(parent => [graph.relativeDepths.get(child) - graph.relativeDepths.get(parent), Math.round(Math.abs(normalizedX(child) - normalizedX(parent)) * 8), parents.length].join(':'))).sort();
  return `${graph.parents.filter(parents => parents.length === 0).length}|${nodes.join(',')}|${edges.join(',')}`;
}

function layerVector(graph) {
  if (!graph.objects.length) return [];
  const minX = Math.min(...graph.bounds.map(value => value.minX));
  const maxX = Math.max(...graph.bounds.map(value => value.maxX));
  const width = Math.max(0.01, maxX - minX);
  const output = [];
  for (let depth = 1; depth <= graph.relativeMaxDepth; depth += 1) {
    const indices = graph.objects.map((_, index) => index).filter(index => graph.relativeDepths.get(index) === depth);
    if (!indices.length) { output.push([0, 0, 0, 0, 0, 0, 0, 0]); continue; }
    const layerMin = Math.min(...indices.map(index => graph.bounds[index].minX));
    const layerMax = Math.max(...indices.map(index => graph.bounds[index].maxX));
    const buckets = [...new Set(indices.map(index => Math.round((graph.objects[index].x - minX) / width * 12)))].sort((a, b) => a - b);
    let spans = buckets.length ? 1 : 0;
    for (let index = 1; index < buckets.length; index += 1) if (buckets[index] - buckets[index - 1] > 1) spans += 1;
    const center = ((layerMin + layerMax) / 2 - minX) / width;
    output.push([
      Math.min(1, indices.length / 8), Math.min(1, spans / 4), (layerMax - layerMin) / width,
      Math.abs(center - 0.5) * 2, Math.min(1, indices.filter(index => graph.children[index].length > 1).length / 3),
      Math.min(1, indices.filter(index => graph.parents[index].length > 1).length / 3),
      Math.min(1, indices.filter(index => roleOf(graph.objects[index]) === 'beam' && graph.parents[index].length > 1).length / 3),
      Math.min(1, depth / Math.max(1, graph.relativeMaxDepth)),
    ]);
  }
  return output;
}

const CONNECTION_LABELS = Object.freeze({ 'cross-platform-dense': '密集跨台桥堡', 'cross-platform': '跨台桥堡', 'cross-layer': '错层跨架', 'branch-merge': '分合塔群', arcade: '多孔门架', 'dense-gallery': '密集回廊', gallery: '多层回廊', branching: '分叉塔群', converging: '汇流门架' });
const CONTOUR_LABELS = Object.freeze({ asymmetric: '偏心', 'high-step': '多阶', stepped: '阶梯', 'wide-terrace': '宽退台', terraced: '退台', truncated: '非对称终止', balanced: '均衡' });

function classifyMacro({ platformRegionCount, crossPlatformNodes, crossLayerConnections, forks, merges, connectors, openings, asymmetry, widthChanges, offsetChanges, terminalDepths }) {
  const connection = platformRegionCount > 1 && crossPlatformNodes > 0 ? (connectors >= 12 ? 'cross-platform-dense' : 'cross-platform')
    : crossLayerConnections > 0 ? 'cross-layer' : merges - forks >= 6 ? 'converging'
      : connectors >= 12 ? 'dense-gallery' : connectors >= 11 ? 'gallery' : openings >= 4 ? 'arcade' : forks > merges ? 'branching' : 'branch-merge';
  const terminalVariation = terminalDepths.length > 1 && Math.max(...terminalDepths) !== Math.min(...terminalDepths);
  const contour = asymmetry >= 0.2 ? 'asymmetric' : widthChanges >= 7 ? 'wide-terrace' : widthChanges >= 5 ? 'terraced'
    : offsetChanges >= 4 ? 'high-step' : offsetChanges >= 3 ? 'stepped' : terminalVariation ? 'truncated' : 'balanced';
  return `${connection}.${contour}`;
}

export function macroCategoryLabel(category) {
  const [connection, contour] = category.split('.');
  return `${CONTOUR_LABELS[contour] ?? contour}${CONNECTION_LABELS[connection] ?? connection}`;
}

export function reconstructLevelStructure(level, assets = {}) {
  const graph = inferGraph(level, assets);
  const components = componentSizes(graph);
  const grid = canonicalGrid(graph);
  const architecture = architectureMetrics(graph, grid);
  const layers = layerVector(graph);
  const normalSignature = supportSignatureFor(graph, false);
  const mirrorSignature = supportSignatureFor(graph, true);
  const supportSignature = normalSignature < mirrorSignature ? normalSignature : mirrorSignature;
  const forks = graph.children.filter(children => children.length > 1).length;
  const merges = graph.parents.filter(parents => parents.length > 1).length;
  const connectors = graph.objects.filter((object, index) => isConnector(object) && graph.parents[index].length > 1).length;
  const crossLayerConnections = graph.objects.filter((object, index) => isConnector(object) && graph.parents[index].length > 1
    && new Set(graph.parents[index].map(parent => graph.relativeDepths.get(parent))).size > 1).length;
  const crossPlatformNodes = graph.objects.filter((_, index) => graph.propagatedRegions.get(index)?.size > 1).length;
  const widths = layers.map(layer => layer[2]).filter(Boolean);
  const offsets = layers.map(layer => layer[3]);
  const bridgeOpenings = graph.objects.filter((object, index) => isConnector(object) && graph.parents[index].length > 1
    && Math.max(...graph.parents[index].map(parent => graph.objects[parent].x)) - Math.min(...graph.parents[index].map(parent => graph.objects[parent].x)) >= 0.45).length;
  const openings = Math.max(grid.whitespace.size ? Math.max(1, Math.round(grid.whitespace.size / 24)) : 0, Math.min(3, bridgeOpenings));
  const asymmetry = offsets.length ? offsets.reduce((sum, value) => sum + value, 0) / offsets.length : 0;
  const terminalDepths = graph.children.map((children, index) => children.length ? null : graph.relativeDepths.get(index)).filter(value => value > 0);
  const widthChanges = widths.slice(1).filter((value, index) => Math.abs(value - widths[index]) >= 0.08).length;
  const offsetChanges = offsets.slice(1).filter((value, index) => Math.abs(value - offsets[index]) >= 0.06).length;
  const evidenceCategories = new Set(['vertical']);
  if (forks || merges) evidenceCategories.add('topology');
  if (openings || bridgeOpenings) evidenceCategories.add('opening');
  if (connectors) evidenceCategories.add('connection');
  if (widthChanges || offsetChanges) evidenceCategories.add('contour');
  if (terminalDepths.length > 1 && Math.max(...terminalDepths) !== Math.min(...terminalDepths)) evidenceCategories.add('termination');
  if (graph.rootIndices.length >= 2) evidenceCategories.add('stability');
  const effectiveRewriteCount = Math.min(20, Math.max(0,
    new Set(graph.objects.map((object, index) => isConnector(object) ? graph.depths.get(index) : null).filter(Boolean)).size
    + Math.min(4, forks) + Math.min(4, merges) + Math.min(3, bridgeOpenings) + (widthChanges ? 1 : 0)));
  const topologyKey = classifyMacro({ platformRegionCount: graph.platformRegionCount, crossPlatformNodes, crossLayerConnections, forks, merges, connectors, openings, asymmetry, widthChanges, offsetChanges, terminalDepths });
  const macroProfile = macroProfileFor(graph);
  const macroFingerprint = macroFingerprintFor(macroProfile);
  return {
    version: STRUCTURE_DESCRIPTOR_VERSION, platformType: level.platformType, objectCount: graph.objects.length,
    connectedComponentCount: components.length,
    largestComponentRatio: graph.objects.length ? (components[0] ?? 0) / graph.objects.length : 0,
    detachedComponentSizes: components.slice(1),
    maxDepth: graph.maxDepth, rootPathCount: graph.rootIndices.length, contour: grid.contour, whitespace: grid.whitespace,
    layerVector: layers, supportSignature, topologyKey, architecture, topology: { forks, merges, connectors, crossLayerConnections, crossPlatformNodes, platformRegionCount: graph.platformRegionCount, openings, asymmetry },
    complexity: { effectiveRewriteCount, categories: [...evidenceCategories].sort(), widthChanges, offsetChanges, bridgeOpenings, terminalDepths },
    macroProfile, macroFingerprint,
    nodes: graph.objects.map((object, index) => ({ id: object.id, depth: graph.depths.get(index), role: roleOf(object), rootRegions: [...graph.propagatedRegions.get(index)].sort(), parentIds: graph.parents[index].map(parent => graph.objects[parent].id) })),
  };
}

export function jaccard(left, right) {
  const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

export function layerVectorSimilarity(left, right) {
  const length = Math.max(left.length, right.length, 1);
  let difference = 0;
  for (let layer = 0; layer < length; layer += 1) {
    const a = left[layer] ?? Array(8).fill(0);
    const b = right[layer] ?? Array(8).fill(0);
    const groups = [[0, 1], [2, 3], [4, 5, 6], [7]];
    difference += groups.reduce((sum, group) => sum + group.reduce((total, index) => total + Math.abs(a[index] - b[index]), 0) / group.length, 0) / groups.length;
  }
  return Math.max(0, 1 - difference / length);
}

export function macroProfileSimilarity(left = [], right = []) {
  const length = Math.max(left.length, right.length, 1);
  let difference = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? { spanCount: 0, envelopeWidth: 0, largestSpanWidth: 0, centerOffset: 0, voidCount: 0, centerVoid: false };
    const b = right[index] ?? { spanCount: 0, envelopeWidth: 0, largestSpanWidth: 0, centerOffset: 0, voidCount: 0, centerVoid: false };
    difference += (
      Math.abs(Math.min(3, a.spanCount) - Math.min(3, b.spanCount)) / 3
      + Math.abs(a.envelopeWidth - b.envelopeWidth)
      + Math.abs(a.largestSpanWidth - b.largestSpanWidth)
      + Math.min(1, Math.abs(a.centerOffset - b.centerOffset) * 2)
      + Math.abs(Math.min(3, a.voidCount) - Math.min(3, b.voidCount)) / 3
      + Number(a.centerVoid !== b.centerVoid)
    ) / 6;
  }
  return Math.max(0, 1 - difference / length);
}

export function compareStructureDescriptors(left, right) {
  return {
    contourJaccard: jaccard(left.contour, right.contour), whitespaceJaccard: jaccard(left.whitespace, right.whitespace),
    layerSimilarity: layerVectorSimilarity(left.layerVector, right.layerVector), supportSignatureEqual: left.supportSignature === right.supportSignature,
    macroSimilarity: macroProfileSimilarity(left.macroProfile, right.macroProfile),
    macroFingerprintEqual: left.macroFingerprint === right.macroFingerprint,
  };
}

export function isNearDuplicate(left, right) {
  const comparison = compareStructureDescriptors(left, right);
  return {
    duplicate: comparison.contourJaccard > 0.8
      || (comparison.supportSignatureEqual && comparison.whitespaceJaccard > 0.7)
      || (comparison.layerSimilarity > 0.9 && comparison.contourJaccard > 0.7)
      || comparison.macroFingerprintEqual
      || (comparison.macroSimilarity > 0.90 && comparison.contourJaccard > 0.55),
    ...comparison,
  };
}

export function structureSignature(descriptor) {
  return `${descriptor.version}|${descriptor.supportSignature}|${setKey(descriptor.contour)}`;
}
