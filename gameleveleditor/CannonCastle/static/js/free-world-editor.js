import { constrainDrag, supportSnap } from "./placement-collision.js";
import { expandFrozenSelection } from "./frozen-body-model.js";

const MAGNETIC_SNAP_PIXELS = 24;        // how close (screen px) an edge/center must be to magnetically snap
const radians = angle => Number(angle || 0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const NUDGE_BOUNDS = { x: [0.1, 8.9], y: [1.6, 12.2] };

export function projectileVisualShape(body, original = {}) {
  const shape = structuredClone(body.shape ?? (body.radius != null ? { kind: "circle", radius: body.radius } : original.shape ?? { kind: "circle", radius: 0.2 }));
  if (shape.kind !== "circle") return shape;
  const radius = shape.radius ?? body.radius ?? original.shape?.radius ?? 0.2;
  return { ...shape, radius: (body.meteorType || body.kind === "meteor") ? radius * 2 : radius };
}

function localPoint(point, object) {
  const angle = -radians(object.angle);
  const dx = point.x - object.x;
  const dy = point.y - object.y;
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle),
    y: dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

function pointInPolygon(point, vertices) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index, index += 1) {
    const a = vertices[index];
    const b = vertices[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function containsPoint(object, point) {
  const local = localPoint(point, object);
  if (object.shape.kind === "box") return Math.abs(local.x) <= object.shape.width / 2 && Math.abs(local.y) <= object.shape.height / 2;
  if (object.shape.kind === "circle") return Math.hypot(local.x, local.y) <= object.shape.radius;
  if (object.shape.kind === "polygon") return pointInPolygon(local, object.shape.vertices);
  return false;
}

function rotateLocal(vertex, object) {
  const angle = radians(object.angle);
  return {
    x: object.x + vertex.x * Math.cos(angle) - vertex.y * Math.sin(angle),
    y: object.y + vertex.x * Math.sin(angle) + vertex.y * Math.cos(angle),
  };
}

function verticesFor(object) {
  if (object.shape.kind === "circle") {
    return [
      { x: object.x - object.shape.radius, y: object.y - object.shape.radius },
      { x: object.x + object.shape.radius, y: object.y + object.shape.radius },
    ];
  }
  const vertices = object.shape.kind === "box" ? [
    { x: -object.shape.width / 2, y: -object.shape.height / 2 },
    { x: object.shape.width / 2, y: -object.shape.height / 2 },
    { x: object.shape.width / 2, y: object.shape.height / 2 },
    { x: -object.shape.width / 2, y: object.shape.height / 2 },
  ] : object.shape.vertices;
  return vertices.map(vertex => rotateLocal(vertex, object));
}

function boundsFor(object) {
  const vertices = verticesFor(object);
  return {
    left: Math.min(...vertices.map(point => point.x)),
    right: Math.max(...vertices.map(point => point.x)),
    top: Math.min(...vertices.map(point => point.y)),
    bottom: Math.max(...vertices.map(point => point.y)),
  };
}

function normalizedRectangle(rectangle) {
  return {
    left: Math.min(rectangle.left, rectangle.right),
    right: Math.max(rectangle.left, rectangle.right),
    top: Math.min(rectangle.top, rectangle.bottom),
    bottom: Math.max(rectangle.top, rectangle.bottom),
  };
}

function intersects(left, right) {
  return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
}

function combinedBounds(objects) {
  const bounds = objects.map(boundsFor);
  return {
    left: Math.min(...bounds.map(value => value.left)),
    right: Math.max(...bounds.map(value => value.right)),
    top: Math.min(...bounds.map(value => value.top)),
    bottom: Math.max(...bounds.map(value => value.bottom)),
  };
}

function axisSnapCorrection(moving, targets, axis, threshold) {
  const start = axis === "x" ? "left" : "top";
  const end = axis === "x" ? "right" : "bottom";
  const crossStart = axis === "x" ? "top" : "left";
  const crossEnd = axis === "x" ? "bottom" : "right";
  const movingCenter = (moving[start] + moving[end]) / 2;
  let best = null;
  for (const target of targets) {
    const targetCenter = (target[start] + target[end]) / 2;
    for (const [correction, value] of [
      [target[start] - moving[start], target[start]],
      [targetCenter - movingCenter, targetCenter],
      [target[end] - moving[end], target[end]],
      [target[end] - moving[start], target[end]],
      [target[start] - moving[end], target[start]],
    ]) {
      if (Math.abs(correction) > threshold) continue;
      if (best === null || Math.abs(correction) < Math.abs(best.correction)) {
        best = {
          correction,
          guide: {
            axis,
            value,
            start: Math.min(moving[crossStart], target[crossStart]),
            end: Math.max(moving[crossEnd], target[crossEnd]),
          },
        };
      }
    }
  }
  return best ?? { correction: 0, guide: null };
}

export function snapDragAlignment({ objects = [], selectedIds = [], dx = 0, dy = 0, threshold = 0 } = {}) {
  const selected = new Set(selectedIds);
  const movingObjects = objects.filter(object => selected.has(object.id)).map(object => ({
    ...object,
    x: Number(object.x) + dx,
    y: Number(object.y) + dy,
  }));
  const targets = objects.filter(object => !selected.has(object.id)).map(boundsFor);
  if (!movingObjects.length || !targets.length || threshold <= 0) return { dx, dy, guides: [] };
  const moving = combinedBounds(movingObjects);
  const xSnap = axisSnapCorrection(moving, targets, "x", threshold);
  const ySnap = axisSnapCorrection(moving, targets, "y", threshold);
  return {
    dx: dx + xSnap.correction,
    dy: dy + ySnap.correction,
    guides: [xSnap.guide, ySnap.guide].filter(Boolean),
  };
}

export function snapDragDelta(options = {}) {
  const { dx, dy } = snapDragAlignment(options);
  return { dx, dy };
}

export function createFreeWorldEditor(canvas, store, options = {}) {
  const listeners = [];
  const render = options.render || (() => {});
  let mode = "preview";
  let clipboard = { objects: [], frozenBodies: [] };
  let tool = "select";
  let gesture = null;
  let alignmentGuides = [];
  const viewport = { x: 0, y: 0, zoom: 1 };

  const baseLayout = () => {
    const layout = getBoardLayout(store.currentLevel, canvas, store.config);
    return { scale: layout.scale, left: layout.left, top: layout.top };
  };
  const eventScreen = event => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height,
    };
  };
  const screenToWorld = point => {
    const layout = baseLayout();
    return {
      x: (point.x - layout.left - viewport.x) / (layout.scale * viewport.zoom),
      y: (point.y - layout.top - viewport.y) / (layout.scale * viewport.zoom),
    };
  };
  const hitTest = point => {
    const objects = store.currentLevel?.castle || [];
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      if (containsPoint(objects[index], point)) return objects[index].id;
    }
    return null;
  };
  const editable = () => mode !== "play" && mode !== "debug";
  const selectAt = (point, { additive = false } = {}) => {
    if (!editable()) return null;
    const id = hitTest(point);
    if (!id) store.selectObjects(additive ? store.selectedObjectIds : []);
    else if (additive) {
      const targetIds = new Set(expandFrozenSelection(store.currentLevel, [id]));
      const removeGroup = [...targetIds].every(targetId => store.selectedObjectIds.includes(targetId));
      store.selectObjects(removeGroup
        ? store.selectedObjectIds.filter(selectedId => !targetIds.has(selectedId))
        : [...store.selectedObjectIds, ...targetIds]);
    }
    else store.selectObjects([id]);
    return id;
  };
  const selectMarquee = (rectangle, { additive = false } = {}) => {
    if (!editable()) return [];
    const area = normalizedRectangle(rectangle);
    const ids = (store.currentLevel?.castle || []).filter(object => intersects(boundsFor(object), area)).map(object => object.id);
    store.selectObjects(additive ? [...store.selectedObjectIds, ...ids] : ids);
    return ids;
  };

  const moveSelection = (dx, dy) => {
    if (!editable()) return false;
    const selectedIds = new Set(store.selectedObjectIds);
    const objects = (store.currentLevel?.castle || []).filter(object => selectedIds.has(object.id));
    if (!objects.length) return false;
    const boundedDx = clamp(
      dx,
      NUDGE_BOUNDS.x[0] - Math.min(...objects.map(object => Number(object.x))),
      NUDGE_BOUNDS.x[1] - Math.max(...objects.map(object => Number(object.x))),
    );
    const boundedDy = clamp(
      dy,
      NUDGE_BOUNDS.y[0] - Math.min(...objects.map(object => Number(object.y))),
      NUDGE_BOUNDS.y[1] - Math.max(...objects.map(object => Number(object.y))),
    );
    return store.updateObjects(store.selectedObjectIds, object => ({
      ...object,
      x: Number(object.x) + boundedDx,
      y: Number(object.y) + boundedDy,
    }));
  };
  const nudgeSelection = (direction, { fine = false } = {}) => {
    const amount = fine ? 0.01 : 0.05;
    const delta = {
      left: [-amount, 0], right: [amount, 0], up: [0, -amount], down: [0, amount],
    }[direction];
    if (delta) moveSelection(...delta);
  };
  const rotateSelection = deltaRadians => editable()
    ? store.rotateObjects(store.selectedObjectIds, deltaRadians)
    : false;
  const duplicateSelection = () => editable() ? store.duplicateObjects(store.selectedObjectIds) : false;
  const deleteSelection = () => editable() ? store.deleteObjects(store.selectedObjectIds) : false;
  function pointerDown(event) {
    if (mode !== "edit") return;
    canvas.focus?.();
    const screen = eventScreen(event);
    if (event.button === 1 || tool === "move") {
      gesture = { type: "pan", screen, viewport: { ...viewport } };
    } else if (event.button === 0) {
      const world = screenToWorld(screen);
      const hit = hitTest(world);
      if (hit) {
        if (!store.selectedObjectIds.includes(hit) || event.shiftKey) selectAt(world, { additive: event.shiftKey });
        if (!store.selectedObjectIds.includes(hit)) {
          event.preventDefault?.();
          return;
        }
        const before = store.beginGesture();
        const originals = new Map((store.currentLevel?.castle || []).filter(object => store.selectedObjectIds.includes(object.id)).map(object => [object.id, structuredClone(object)]));
        gesture = { type: "drag", screen, world, before, originals, moved: false, anchorId: hit };
      } else {
        const previous = [...store.selectedObjectIds];
        if (!event.shiftKey) store.selectObjects([]);
        gesture = { type: "marquee", screen, world, previous, additive: event.shiftKey };
      }
    }
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault?.();
  }

  function pointerMove(event) {
    if (!gesture) return;
    const screen = eventScreen(event);
    if (gesture.type === "pan") {
      viewport.x = gesture.viewport.x + screen.x - gesture.screen.x;
      viewport.y = gesture.viewport.y + screen.y - gesture.screen.y;
    } else if (gesture.type === "drag") {
      const world = screenToWorld(screen);
      const rawDx = world.x - gesture.world.x;
      const rawDy = world.y - gesture.world.y;
      const layout = baseLayout();
      const { dx, dy, guides } = snapDragAlignment({
        objects: store.currentLevel?.castle || [],
        selectedIds: [...gesture.originals.keys()],
        dx: rawDx,
        dy: rawDy,
        threshold: MAGNETIC_SNAP_PIXELS / (layout.scale * viewport.zoom),
      });
      const anchorOriginal = gesture.originals.get(gesture.anchorId);
      let finalDx = dx;
      let finalDy = dy;
      if (anchorOriginal) {
        const snapped = supportSnap({
          objects: [...gesture.originals.values()],
          environment: store.currentLevel?.environment,
          anchorId: gesture.anchorId,
          x: anchorOriginal.x + dx,
          y: anchorOriginal.y + dy,
          excludeIds: new Set(gesture.originals.keys()),
        });
        finalDx = snapped.x - anchorOriginal.x;
        finalDy = snapped.y - anchorOriginal.y;
      }
      const constrained = constrainDrag({
        moving: [...gesture.originals.values()],
        resting: [],
        dx: finalDx,
        dy: finalDy,
      });
      finalDx = constrained.dx;
      finalDy = constrained.dy;
      alignmentGuides = guides.filter(guide => guide.axis === "x"
        ? Math.abs(finalDx - dx) < 1e-9
        : Math.abs(finalDy - dy) < 1e-9);
      gesture.moved ||= Math.abs(rawDx) > 1e-9 || Math.abs(rawDy) > 1e-9;
      store.previewObjects([...gesture.originals.keys()], object => {
        const original = gesture.originals.get(object.id);
        return { ...original, x: original.x + finalDx, y: original.y + finalDy };
      });
    } else if (gesture.type === "marquee") {
      gesture.current = screenToWorld(screen);
    }
    render();
    event.preventDefault?.();
  }

  function finishPointer(event, cancelled = false) {
    if (!gesture) return;
    if (gesture.type === "drag") {
      if (cancelled) store.cancelGesture(gesture.before);
      else if (gesture.moved) store.commitGesture(gesture.before);
    } else if (gesture.type === "pan" && cancelled) {
      Object.assign(viewport, gesture.viewport);
    } else if (gesture.type === "marquee") {
      if (cancelled) store.selectObjects(gesture.previous);
      else if (gesture.current) selectMarquee({ left: gesture.world.x, top: gesture.world.y, right: gesture.current.x, bottom: gesture.current.y }, { additive: gesture.additive });
    }
    alignmentGuides = [];
    gesture = null;
    canvas.releasePointerCapture?.(event.pointerId);
    render();
  }

  function wheel(event) {
    const screen = eventScreen(event);
    zoomAt(screen, Math.exp(-event.deltaY * 0.001));
    event.preventDefault?.();
  }

  function zoomAt(screen, factor) {
    const anchor = screenToWorld(screen);
    const layout = baseLayout();
    viewport.zoom = clamp(viewport.zoom * factor, 0.2, 8);
    viewport.x = screen.x - layout.left - anchor.x * layout.scale * viewport.zoom;
    viewport.y = screen.y - layout.top - anchor.y * layout.scale * viewport.zoom;
    render();
  }

  function keyDown(event) {
    if (mode !== "edit") return;
    if (event.target?.matches?.("input,textarea,select,[contenteditable=true]")) return;
    const key = event.key.toLowerCase();
    if (key.startsWith("arrow")) nudgeSelection(key.slice(5), { fine: event.shiftKey });
    else if ((event.ctrlKey || event.metaKey) && key === "c") {
      const selected = new Set(store.selectedObjectIds);
      clipboard = {
        objects: (store.currentLevel?.castle || [])
          .filter(object => selected.has(object.id))
          .map(object => structuredClone(object)),
        frozenBodies: (store.currentLevel?.frozenBodies || [])
          .filter(group => group.memberIds.every(id => selected.has(id)))
          .map(group => structuredClone(group)),
      };
    }
    else if ((event.ctrlKey || event.metaKey) && key === "v") store.pasteObjects(clipboard, { x: 0.1, y: 0.1 });
    else if ((event.ctrlKey || event.metaKey) && key === "d") duplicateSelection();
    else if (key === "delete" || key === "backspace") deleteSelection();
    else if ((event.ctrlKey || event.metaKey) && key === "z" && event.shiftKey) store.redo();
    else if ((event.ctrlKey || event.metaKey) && key === "z") store.undo();
    else if ((event.ctrlKey || event.metaKey) && key === "]") rotateSelection(Math.PI / 2);
    else if ((event.ctrlKey || event.metaKey) && key === "[") rotateSelection(-Math.PI / 2);
    else return;
    event.preventDefault?.();
  }

  function doubleClick(event) {
    if (mode !== "edit") return;
    const id = hitTest(screenToWorld(eventScreen(event)));
    if (!id) return;
    store.selectObjects([id]);
    options.onObjectDoubleClick?.(id);
    event.preventDefault?.();
  }

  function listen(name, handler, settings) {
    canvas.addEventListener(name, handler, settings);
    listeners.push(() => canvas.removeEventListener(name, handler, settings));
  }
  listen("pointerdown", pointerDown);
  listen("pointermove", pointerMove);
  listen("pointerup", event => finishPointer(event));
  listen("pointercancel", event => finishPointer(event, true));
  listen("wheel", wheel, { passive: false });
  listen("keydown", keyDown);
  listen("dblclick", doubleClick);
  canvas.tabIndex = 0;

  return {
    viewport,
    get alignmentGuides() { return alignmentGuides.map(guide => ({ ...guide })); },
    hitTest,
    selectAt,
    selectMarquee,
    moveSelection,
    nudgeSelection,
    rotateSelection,
    duplicateSelection,
    deleteSelection,
    undo: () => editable() ? store.undo() : false,
    redo: () => editable() ? store.redo() : false,
    screenToWorld,
    setMode(next) { mode = next; alignmentGuides = []; },
    setTool(next) { tool = next; },
    zoomBy(factor, anchor = { x: canvas.width / 2, y: canvas.height / 2 }) { zoomAt(anchor, factor); },
    resetViewport() { Object.assign(viewport, { x: 0, y: 0, zoom: 1 }); render(); },
    destroy() { listeners.splice(0).forEach(remove => remove()); },
  };
}
import { getBoardLayout } from "../../gamelogic.js";
