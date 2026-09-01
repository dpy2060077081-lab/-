import assert from 'node:assert/strict';
import test from 'node:test';

import * as editorModule from '../static/js/editor.js';
import { EditorStore } from '../static/js/editor-store.js';
import { createFreeWorldEditor, snapDragDelta } from '../static/js/free-world-editor.js';
import { constrainDrag, findFreePlacement, objectBounds, shapesOverlap, supportSnap } from '../static/js/placement-collision.js';

const config = { canvas: { width: 900, height: 1600 }, world: { width: 9, height: 16 } };
const assets = {
  materials: {
    wood: {
      id: 'wood', name: 'Wood', color: '#996644', mass: 2, friction: 0.5,
      restitution: 0.4, destructible: true, maxHp: 2, hitSpeedThreshold: 3,
    },
  },
  shapes: {
    square: { id: 'square', name: 'Square', shape: { kind: 'box', width: 0.5, height: 0.5 } },
  },
  specialObjects: {},
};

function level() {
  return {
    levelNumber: 1,
    levelName: '形状测试',
    objectProfiles: {},
    global: {},
    meteor: {},
    explosive: {},
    launcher: {},
    environment: {},
    castle: [
      { id: 'box', x: 2, y: 2, angle: 0, shape: { kind: 'box', width: 2, height: 2, bevel: 0.2 }, plugin: { box: true } },
      { id: 'circle', x: 5, y: 2, angle: 0, shape: { kind: 'circle', radius: 1, sensor: false }, plugin: { circle: true } },
      { id: 'polygon', x: 4, y: 6, angle: 0, shape: { kind: 'polygon', vertices: [{ x: -1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: -1 }], winding: 'cw' }, plugin: { polygon: true } },
    ],
  };
}

function harness({
  rect = { left: 0, top: 0, width: 900, height: 1600 },
  levels = [{ ...level(), fileName: 'level-1.json', filePath: 'level/level-1.json' }],
  editorOptions = {},
} = {}) {
  const listeners = new Map();
  const context = new Proxy({}, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
    set(target, property, value) { target[property] = value; return true; },
  });
  const canvas = {
    width: 900,
    height: 1600,
    ownerDocument: { defaultView: { devicePixelRatio: 1 } },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return rect; },
    getContext() { return context; },
  };
  const store = new EditorStore({
    config,
    assets,
    levels,
  });
  const editor = createFreeWorldEditor(canvas, store, { render: () => {}, ...editorOptions });
  const emit = (name, overrides = {}) => listeners.get(name)?.({
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    deltaY: 0,
    key: '',
    preventDefault() {},
    ...overrides,
  });
  return { canvas, editor, emit, store };
}

test('keyboard copy and paste duplicates a multi-selection with one shared offset', () => {
  const { editor, emit, store } = harness();
  editor.setMode('edit');
  store.selectObjects(['box', 'circle']);

  emit('keydown', { key: 'c', ctrlKey: true });
  emit('keydown', { key: 'v', ctrlKey: true });

  assert.equal(store.currentLevel.castle.length, 5);
  const copies = store.currentLevel.castle.filter(object => store.selectedObjectIds.includes(object.id));
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map(({ x, y }) => ({ x, y })), [{ x: 2.1, y: 2.1 }, { x: 5.1, y: 2.1 }]);
  assert.notEqual(copies[0].id, 'box');
  assert.notEqual(copies[1].id, 'circle');
});

test('keyboard copy and paste preserves complete frozen groups and stays atomic', () => {
  const frozenLevel = {
    ...level(),
    fileName: 'clipboard-frozen-level.json',
    filePath: 'level/clipboard-frozen-level.json',
    castle: [
      { id: 'a-left', x: 1, y: 4, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
      { id: 'a-right', x: 2, y: 4, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
      { id: 'b-left', x: 4, y: 4, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
      { id: 'b-right', x: 5, y: 4, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
      { id: 'solo', x: 7, y: 4, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
    ],
    frozenBodies: [
      { id: 'ice-a', memberIds: ['a-left', 'a-right'] },
      { id: 'ice-b', memberIds: ['b-left', 'b-right'] },
    ],
  };
  const { editor, emit, store } = harness({ levels: [frozenLevel] });
  editor.setMode('edit');
  store.selectObjects(['a-left', 'b-right', 'solo']);
  const before = store.snapshot();

  emit('keydown', { key: 'c', ctrlKey: true });
  assert.deepEqual(store.snapshot(), before);
  emit('keydown', { key: 'v', ctrlKey: true });
  const after = store.snapshot();

  assert.equal(after.levels[0].castle.length, 10);
  assert.equal(after.levels[0].frozenBodies.length, 4);
  assert.deepEqual(after.levels[0].frozenBodies.slice(0, 2), before.levels[0].frozenBodies);
  assert.deepEqual(after.levels[0].frozenBodies.slice(2).map(group => group.memberIds), [
    ['a-left-copy', 'a-right-copy'],
    ['b-left-copy', 'b-right-copy'],
  ]);
  assert.ok(after.levels[0].frozenBodies.slice(2).every(group => !['ice-a', 'ice-b'].includes(group.id)));
  assert.equal(after.levels[0].frozenBodies.slice(2).some(group => group.memberIds.includes('solo-copy')), false);
  assert.deepEqual([...after.selectedObjectIds].sort(), [
    'a-left-copy',
    'a-right-copy',
    'b-left-copy',
    'b-right-copy',
    'solo-copy',
  ]);

  assert.equal(store.undo(), true);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.snapshot(), after);
});

test('double-clicking an object selects it and publishes its id', () => {
  const opened = [];
  const { editor, emit, store } = harness({ editorOptions: { onObjectDoubleClick: id => opened.push(id) } });
  editor.setMode('edit');

  emit('dblclick', { clientX: 200, clientY: 200 });

  assert.deepEqual(store.selectedObjectIds, ['box']);
  assert.deepEqual(opened, ['box']);
});

test('entering edit mode restores the selected second level without jumping to level 1', () => {
  assert.equal(typeof editorModule.enterCurrentLevelEdit, 'function');
  const first = { ...level(), fileName: 'level-1.json', filePath: 'level/level-1.json' };
  const second = {
    ...level(),
    levelNumber: 2,
    levelName: '第二关',
    workspaceId: 'workspace:second',
    fileName: 'level-2.json',
    filePath: 'level/level-2.json',
  };
  const { editor, store } = harness({ levels: [first, second] });
  store.selectLevel('workspace:second');
  store.selectObjects(['box']);
  Object.assign(editor.viewport, { x: 37, y: -19, zoom: 1.75 });
  const editContext = editorModule.captureEditContext(store, editor);
  const workspaceBeforePlay = store.snapshot();

  editor.setMode('play');
  const setModeCalls = [];
  const setMode = editor.setMode.bind(editor);
  editor.setMode = nextMode => {
    setModeCalls.push(nextMode);
    return setMode(nextMode);
  };
  store.selectObjects([]);
  Object.assign(editor.viewport, { x: 0, y: 0, zoom: 1 });
  let exits = 0;
  const selectLevelCalls = [];
  const selectLevel = store.selectLevel.bind(store);
  store.selectLevel = id => {
    selectLevelCalls.push(id);
    return selectLevel(id);
  };

  const result = editorModule.enterCurrentLevelEdit({
    mode: 'play',
    store,
    freeEditor: editor,
    playSequence: { exit() { exits += 1; } },
    editContext,
  });

  assert.deepEqual(result, { mode: 'edit', playSequence: null, editContext: null });
  assert.equal(exits, 1);
  assert.deepEqual(setModeCalls, ['edit']);
  assert.equal(store.currentLevelId, 'workspace:second');
  assert.equal(store.currentLevel.levelNumber, 2);
  assert.deepEqual(selectLevelCalls, ['workspace:second']);
  assert.deepEqual(store.selectedObjectIds, ['box']);
  assert.deepEqual(editor.viewport, { x: 37, y: -19, zoom: 1.75 });
  assert.deepEqual(store.snapshot(), workspaceBeforePlay);
});

test('hit testing handles rotated boxes, circles, and polygons and chooses the topmost object', () => {
  const { editor, store } = harness();
  assert.equal(editor.hitTest({ x: 2, y: 2 }), 'box');
  assert.equal(editor.hitTest({ x: 5.8, y: 2 }), 'circle');
  assert.equal(editor.hitTest({ x: 4, y: 6 }), 'polygon');
  assert.equal(editor.hitTest({ x: 8, y: 15 }), null);

  store.updateObjects(['box'], (object) => ({ ...object, x: 4, y: 6 }));
  assert.equal(editor.hitTest({ x: 4, y: 6 }), 'polygon');
});

test('drag snapping aligns nearby object edges and centers while ignoring distant objects', () => {
  const objects = level().castle;

  assert.deepEqual(snapDragDelta({
    objects,
    selectedIds: ['box'],
    dx: 0.94,
    dy: 0,
    threshold: 0.08,
  }), { dx: 1, dy: 0 });
  assert.deepEqual(snapDragDelta({
    objects,
    selectedIds: ['box'],
    dx: 0.7,
    dy: 0.3,
    threshold: 0.08,
  }), { dx: 0.7, dy: 0.3 });
});

test('single, additive, and marquee selection do not dirty level data', () => {
  const { editor, store } = harness();
  editor.selectAt({ x: 2, y: 2 });
  editor.selectAt({ x: 5, y: 2 }, { additive: true });
  assert.deepEqual(store.selectedObjectIds, ['box', 'circle']);

  editor.selectMarquee({ left: 3, top: 5, right: 5, bottom: 7 });
  assert.deepEqual(store.selectedObjectIds, ['polygon']);
  assert.equal(store.dirty, false);
  assert.equal(store.history.length, 0);
});

test('shift-click toggles individual objects within a multi-selection', () => {
  const { editor, emit, store } = harness();
  editor.setMode('edit');

  emit('pointerdown', { clientX: 200, clientY: 200 });
  emit('pointerup', { clientX: 200, clientY: 200 });
  emit('pointerdown', { clientX: 500, clientY: 200, shiftKey: true });
  emit('pointerup', { clientX: 500, clientY: 200, shiftKey: true });
  assert.deepEqual(store.selectedObjectIds, ['box', 'circle']);

  emit('pointerdown', { clientX: 500, clientY: 200, shiftKey: true });
  emit('pointerup', { clientX: 500, clientY: 200, shiftKey: true });
  assert.deepEqual(store.selectedObjectIds, ['box']);
});

test('shift-click removes a selected frozen body as one complete group', () => {
  const frozenLevel = {
    ...level(),
    fileName: 'frozen-shift-level.json',
    filePath: 'level/frozen-shift-level.json',
    castle: [
      { id: 'ice-left', x: 2, y: 2, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
      { id: 'ice-right', x: 3, y: 2, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
    ],
    frozenBodies: [{ id: 'ice-group', memberIds: ['ice-left', 'ice-right'] }],
  };
  const { editor, emit, store } = harness({ levels: [frozenLevel] });
  editor.setMode('edit');

  emit('pointerdown', { clientX: 200, clientY: 200 });
  emit('pointerup', { clientX: 200, clientY: 200 });
  assert.deepEqual(store.selectedObjectIds, ['ice-left', 'ice-right']);

  emit('pointerdown', { clientX: 200, clientY: 200, shiftKey: true });
  emit('pointerup', { clientX: 200, clientY: 200, shiftKey: true });
  assert.deepEqual(store.selectedObjectIds, []);
});

test('dragging one selected object moves the whole selection as a group', () => {
  const { editor, emit, store } = harness();
  editor.setMode('edit');
  store.selectObjects(['box', 'circle']);

  emit('pointerdown', { clientX: 200, clientY: 200 });
  emit('pointermove', { clientX: 250, clientY: 200 });
  emit('pointerup', { clientX: 250, clientY: 200 });

  assert.deepEqual(store.currentLevel.castle.slice(0, 2).map(({ x, y }) => ({ x, y })), [
    { x: 2.5, y: 2 },
    { x: 5.5, y: 2 },
  ]);
});

test('nudging a frozen body at a world bound preserves member spacing', () => {
  const frozenLevel = {
    ...level(),
    fileName: 'frozen-bound-level.json',
    filePath: 'level/frozen-bound-level.json',
    castle: [
      { id: 'ice-left', x: 8.87, y: 2, angle: 0, shape: { kind: 'box', width: 0.02, height: 0.5 } },
      { id: 'ice-right', x: 8.89, y: 2, angle: 0, shape: { kind: 'box', width: 0.02, height: 0.5 } },
    ],
    frozenBodies: [{ id: 'ice-group', memberIds: ['ice-left', 'ice-right'] }],
  };
  const { editor, store } = harness({ levels: [frozenLevel] });
  editor.setMode('edit');
  store.selectObjects(['ice-left']);

  editor.nudgeSelection('right');

  const [left, right] = store.currentLevel.castle;
  assert.ok(Math.abs(left.x - 8.88) < 1e-9);
  assert.ok(Math.abs(right.x - 8.9) < 1e-9);
  assert.ok(Math.abs((right.x - left.x) - 0.02) < 1e-9);
});

test('drag, nudge, rotation, duplicate, delete, undo, and redo preserve unknown fields', () => {
  const { editor, store } = harness();
  store.selectObjects(['box', 'circle', 'polygon']);

  editor.moveSelection(0.5, 0.5);
  editor.nudgeSelection('right');
  editor.nudgeSelection('down', { fine: true });
  editor.rotateSelection(Math.PI / 2);
  const edited = structuredClone(store.currentLevel.castle);

  assert.equal(edited[0].x, 2.55);
  assert.equal(edited[0].y, 2.51);
  assert.equal(edited[0].angle, Math.PI / 2);
  assert.deepEqual(edited.map(({ plugin }) => plugin), [{ box: true }, { circle: true }, { polygon: true }]);
  assert.equal(edited[0].shape.bevel, 0.2);
  assert.equal(edited[1].shape.sensor, false);
  assert.equal(edited[2].shape.winding, 'cw');

  editor.rotateSelection(-Math.PI / 2);
  editor.duplicateSelection();
  assert.equal(store.currentLevel.castle.length, 6);
  assert.ok(store.currentLevel.castle.slice(3).every((object) => object.id.endsWith('-copy')));
  editor.deleteSelection();
  assert.equal(store.currentLevel.castle.length, 3);
  assert.equal(editor.undo(), true);
  assert.equal(store.currentLevel.castle.length, 6);
  assert.equal(editor.redo(), true);
  assert.equal(store.currentLevel.castle.length, 3);
});

test('rotateSelection rotates a frozen group through the store group-aware rotation API', () => {
  const frozenLevel = {
    ...level(),
    fileName: 'frozen-level.json',
    filePath: 'level/frozen-level.json',
    castle: [
      { id: 'ice-left', x: 2, y: 4, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
      { id: 'ice-right', x: 3, y: 4, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
      { id: 'solo', x: 6, y: 4, angle: 0, shape: { kind: 'box', width: 1, height: 1 } },
    ],
    frozenBodies: [{ id: 'ice-group', memberIds: ['ice-left', 'ice-right'] }],
  };
  const { editor, store } = harness({ levels: [frozenLevel] });
  editor.setMode('edit');
  store.selectObjects(['ice-left', 'solo']);

  editor.rotateSelection(Math.PI / 2);

  const byId = new Map(store.currentLevel.castle.map(object => [object.id, object]));
  assert.deepEqual(
    ['ice-left', 'ice-right'].map(id => ({ x: byId.get(id).x, y: byId.get(id).y, angle: byId.get(id).angle })),
    [
      { x: 2.5, y: 3.5, angle: Math.PI / 2 },
      { x: 2.5, y: 4.5, angle: Math.PI / 2 },
    ],
  );
  assert.deepEqual(
    { x: byId.get('solo').x, y: byId.get('solo').y, angle: byId.get('solo').angle },
    { x: 6, y: 4, angle: Math.PI / 2 },
  );
});

test('play mode rejects every programmatic edit command without touching the draft or history', () => {
  const { store, editor } = harness();
  store.selectObjects(['box']);
  const before = store.snapshot();

  editor.setMode('play');
  editor.moveSelection(1, 1);
  editor.nudgeSelection('right');
  editor.rotateSelection(Math.PI / 2);
  editor.duplicateSelection();
  editor.deleteSelection();
  editor.undo();
  editor.redo();

  assert.deepEqual(store.snapshot(), before);
});

test('invalid object patches are rejected before the editor store mutates state', () => {
  const { store } = harness();
  store.selectObjects(['box']);
  const before = store.snapshot();

  assert.throws(
    () => store.updateObjects(['box'], object => ({ ...object, friction: 1.5 })),
    error => error.code === 'LEVEL_INVALID' && error.details.path === 'castle.box.friction',
  );
  assert.deepEqual(store.snapshot(), before);
});

test('pointer gestures support drag, middle-button pan, anchored wheel zoom, and keyboard commands', () => {
  const { editor, emit, store } = harness();
  editor.setMode('edit');

  emit('pointerdown', { clientX: 200, clientY: 200 });
  emit('pointermove', { clientX: 250, clientY: 200 });
  emit('pointerup', { clientX: 250, clientY: 200 });
  assert.equal(store.currentLevel.castle[0].x, 2.5);

  emit('pointerdown', { button: 1, clientX: 300, clientY: 300 });
  emit('pointermove', { button: 1, clientX: 340, clientY: 320 });
  emit('pointerup', { button: 1, clientX: 340, clientY: 320 });
  assert.deepEqual(editor.viewport, { x: 40, y: 20, zoom: 1 });

  const anchorBefore = editor.screenToWorld({ x: 450, y: 800 });
  emit('wheel', { clientX: 450, clientY: 800, deltaY: -100 });
  const anchorAfter = editor.screenToWorld({ x: 450, y: 800 });
  assert.ok(editor.viewport.zoom > 1);
  assert.ok(Math.abs(anchorAfter.x - anchorBefore.x) < 1e-9);
  assert.ok(Math.abs(anchorAfter.y - anchorBefore.y) < 1e-9);

  emit('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(store.currentLevel.castle[0].x, 2.49);
  emit('keydown', { key: ']', ctrlKey: true });
  assert.equal(store.currentLevel.castle[0].angle, Math.PI / 2);
  emit('keydown', { key: '[', ctrlKey: true });
  assert.equal(store.currentLevel.castle[0].angle, 0);
});

test('pointer drag magnetically snaps a nearby edge using a screen-space threshold', () => {
  const { editor, emit, store } = harness();
  editor.setMode('edit');

  emit('pointerdown', { clientX: 200, clientY: 200 });
  emit('pointermove', { clientX: 294, clientY: 200 });
  emit('pointerup', { clientX: 294, clientY: 200 });

  assert.equal(store.currentLevel.castle[0].x, 3);
});

test('magnetic drag snapping reaches farther than the old 8px threshold', () => {
  const { editor, emit, store } = harness();
  editor.setMode('edit');

  // box dragged so its right edge lands 0.1 units short of the circle's left edge:
  // inside the magnetic screen-space threshold, so it snaps into alignment at x=3.
  emit('pointerdown', { clientX: 200, clientY: 200 });
  emit('pointermove', { clientX: 290, clientY: 200 });
  emit('pointerup', { clientX: 290, clientY: 200 });

  assert.equal(store.currentLevel.castle[0].x, 3);
});

test('magnetic drag snaps from 22 screen pixels away and exposes a temporary alignment guide', () => {
  const { editor, emit, store } = harness();
  editor.setMode('edit');

  emit('pointerdown', { clientX: 200, clientY: 200 });
  emit('pointermove', { clientX: 278, clientY: 200 });

  assert.equal(store.currentLevel.castle[0].x, 3);
  assert.deepEqual(editor.alignmentGuides.find(guide => guide.axis === 'x'), {
    axis: 'x', value: 4, start: 1, end: 3,
  });

  emit('pointerup', { clientX: 278, clientY: 200 });
  assert.deepEqual(editor.alignmentGuides, []);
});

test('save round-trips box, circle, polygon, and level unknown fields', async () => {
  const writes = new Map();
  const files = {
    async mkdir() {},
    async writeBase64() {},
    async writeText(path, content) { writes.set(path, content); },
    async remove() {},
  };
  const original = { ...level(), authoring: { cameraBookmark: 3 } };
  const store = new EditorStore({
    config,
    assets,
    files,
    levels: [{ ...original, fileName: 'level-1.json', filePath: 'level/level-1.json' }],
  });

  store.updateLevel({ authoring: { cameraBookmark: 4 } });
  await store.save();

  assert.deepEqual(JSON.parse(writes.get('level/level-1.json')), { ...original, authoring: { cameraBookmark: 4 } });
});

test('renumbering the current free-world level keeps that level active', () => {
  const { store } = harness();

  store.updateLevel({ levelNumber: 12 });

  assert.equal(store.currentLevelId, 12);
  assert.equal(store.currentLevel.levelName, '形状测试');
});

test('hit testing treats original 1.57079632679 angles as radians', () => {
  const { editor, store } = harness();
  store.updateObjects(['box'], object => ({
    ...object,
    angle: 1.57079632679,
    shape: { ...object.shape, width: 2, height: 1 },
  }));

  assert.equal(editor.hitTest({ x: 2.4, y: 2.8 }), 'box');
});

test('button and wheel zoom preserve anchors with canvas offset and CSS scaling', () => {
  const { editor, emit } = harness({ rect: { left: 100, top: 50, width: 450, height: 800 } });
  editor.setMode('edit');
  const internalAnchor = { x: 450, y: 800 };
  const beforeButton = editor.screenToWorld(internalAnchor);
  editor.zoomBy(1.25, internalAnchor);
  const afterButton = editor.screenToWorld(internalAnchor);
  assert.deepEqual(afterButton, beforeButton);

  const beforeWheel = editor.screenToWorld(internalAnchor);
  emit('wheel', { clientX: 325, clientY: 450, deltaY: -100 });
  const afterWheel = editor.screenToWorld(internalAnchor);
  assert.ok(Math.abs(afterWheel.x - beforeWheel.x) < 1e-9);
  assert.ok(Math.abs(afterWheel.y - beforeWheel.y) < 1e-9);
});

test('history restores level and image side-effect queues before save', async () => {
  const writes = [];
  const removals = [];
  const files = {
    async mkdir() {},
    async writeBase64(path) { writes.push(path); },
    async writeText() {},
    async remove(path) { removals.push(path); },
  };
  const first = { ...level(), fileName: 'level-1.json', filePath: 'level/level-1.json' };
  const second = { ...level(), levelNumber: 2, fileName: 'level-2.json', filePath: 'level/level-2.json' };
  const historyAssets = structuredClone(assets);
  historyAssets.specialObjects.icon = {
    id: 'icon', name: 'Icon', specialType: 'icon', materialId: 'wood',
    shapePresetId: 'square', color: '#336699', image: 'level/asset/icon.png',
  };
  const store = new EditorStore({ config, assets: historyAssets, files, levels: [first, second] });

  store.deleteLevel(2);
  store.undo();
  store.addAsset(null, {
    id: 'new-icon', name: 'New', catalogType: 'special', specialType: 'new-icon',
    materialId: 'wood', shapePresetId: 'square', color: '#336699', image: 'level/asset/new.png',
  }, 'base64');
  store.undo();
  store.deleteAsset('icon');
  store.undo();
  await store.save();

  assert.deepEqual(writes, []);
  assert.deepEqual(removals, []);
});

test('save removes only root editor metadata and preserves nested namesake fields', async () => {
  const writes = new Map();
  const files = { async mkdir() {}, async writeBase64() {}, async writeText(path, value) { writes.set(path, value); }, async remove() {} };
  const original = { ...level(), extension: { fileName: 'nested.json', filePath: 'nested/path' } };
  const store = new EditorStore({ config, assets, files, levels: [{ ...original, fileName: 'level-1.json', filePath: 'level/level-1.json' }] });

  store.updateLevel({ extension: { ...original.extension, saved: true } });
  await store.save();

  assert.deepEqual(JSON.parse(writes.get('level/level-1.json')), { ...original, extension: { ...original.extension, saved: true } });
});

test('duplicate level numbers are rejected during edit and save', async () => {
  const first = { ...level(), fileName: 'level-1.json', filePath: 'level/level-1.json' };
  const second = { ...level(), levelNumber: 2, fileName: 'level-2.json', filePath: 'level/level-2.json' };
  const store = new EditorStore({ config, assets, levels: [first, second] });
  assert.throws(() => store.updateLevel({ levelNumber: 2 }), /关卡编号已存在/);

  const files = { async mkdir() {}, async writeBase64() {}, async writeText() {}, async remove() {} };
  const invalid = new EditorStore({ config, assets, files, levels: [first, { ...second, levelNumber: 1 }] });
  await assert.rejects(() => invalid.save(), /关卡编号已存在/);
});

function platformLevel() {
  return { ...level(), environment: { platformType: 'single-3' } };
}

test('supportSnap settles an object onto the platform top instead of penetrating', () => {
  const box = { id: 'box', x: 4.6, y: 11.2, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  const result = supportSnap({
    objects: [box],
    environment: { platformType: 'single-3' },
    anchorId: 'box',
    x: 4.6,
    y: 11.2,
    excludeIds: new Set(['box']),
  });
  assert.equal(result.snapped, true);
  assert.equal(result.x, 4.5);          // snaps to the platform center (4.6 is within 0.16)
  assert.equal(result.y, 11.34);        // bottom = 11.34 + 1 = 12.34 = platform top
});

test('supportSnap stacks a box onto another box as exact resting contact, not an overlap', () => {
  const base = { id: 'base', x: 4.5, y: 8, angle: 0, shape: { kind: 'box', width: 3, height: 1 } };
  const top = { id: 'top', x: 4.5, y: 6.7, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  const result = supportSnap({ objects: [base, top], environment: {}, anchorId: 'top', x: 4.5, y: 6.7, excludeIds: new Set(['top']) });
  assert.equal(result.snapped, true);
  assert.equal(result.y, 6.5);          // base top = 7.5, so top center = 7.5 - 1
  const settled = { ...top, ...result };
  assert.equal(shapesOverlap(settled, base), false);
  assert.equal(objectBounds(settled).maxY, 7.5);
});

test('supportSnap never lets an object bottom sink past the buildable floor or walls', () => {
  const box = { id: 'box', x: 4.5, y: 12, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  const result = supportSnap({ objects: [box], environment: {}, anchorId: 'box', x: 4.5, y: 12, excludeIds: new Set(['box']) });
  assert.equal(result.snapped, false);
  assert.equal(result.y, 11.34);        // bottom clamped to 12.34 even without a support
  const wide = supportSnap({ objects: [box], environment: {}, anchorId: 'box', x: 0.1, y: 12, excludeIds: new Set(['box']) });
  assert.equal(wide.x, 1);              // left wall: center must stay >= halfWidth
});

test('shapesOverlap rejects real overlap but permits exact resting and edge contact', () => {
  const boxA = { id: 'a', x: 2, y: 2, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  const boxB = { id: 'b', x: 4, y: 2, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  assert.equal(shapesOverlap(boxA, boxB), false);                       // adjacent, exact contact
  assert.equal(shapesOverlap({ ...boxB, x: 3.9 }, boxA), true);         // 0.1 overlap
  const stacked = { id: 'c', x: 2, y: 0, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  assert.equal(shapesOverlap(stacked, boxA), false);                    // resting on top, exact contact
  assert.equal(shapesOverlap({ ...stacked, y: 0.9 }, boxA), true);      // sunk in
});

test('findFreePlacement returns a non-overlapping in-bounds offset for duplicates', () => {
  const box = { id: 'box', x: 4.5, y: 11.34, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  const offset = findFreePlacement([box], [box]);
  assert.ok(offset);
  const copy = { ...box, x: box.x + offset.x, y: box.y + offset.y };
  assert.equal(shapesOverlap(copy, box), false);
  const bounds = objectBounds(copy);
  assert.ok(bounds.minX >= 0.15 && bounds.maxX <= 8.85 && bounds.minY >= 1.65 && bounds.maxY <= 12.34);
});

test('drag passes through a stationary object while keeping the dragged position', () => {
  const two = { ...level(), castle: [
    { id: 'box', x: 2, y: 2, angle: 0, shape: { kind: 'box', width: 2, height: 2 }, plugin: { box: true } },
    { id: 'box2', x: 5, y: 2, angle: 0, shape: { kind: 'box', width: 2, height: 2 }, plugin: { box: true } },
  ] };
  const { editor, emit, store } = harness({ levels: [{ ...two, fileName: 'level-1.json', filePath: 'level/level-1.json' }] });
  editor.setMode('edit');

  emit('pointerdown', { clientX: 200, clientY: 200 });
  emit('pointermove', { clientX: 400, clientY: 200 });
  emit('pointerup', { clientX: 400, clientY: 200 });

  assert.equal(store.currentLevel.castle[0].x, 4);
  assert.equal(store.currentLevel.castle[0].y, 2);
  assert.equal(shapesOverlap(store.currentLevel.castle[0], store.currentLevel.castle[1]), true);
});

test('constrainDrag clamps movement at the first resting object and at the world bounds', () => {
  const moving = { id: 'moving', x: 2, y: 2, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  const resting = { id: 'resting', x: 5, y: 2, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };
  const floor = { id: 'floor', x: 2, y: 5, angle: 0, shape: { kind: 'box', width: 2, height: 2 } };

  assert.deepEqual(constrainDrag({ moving: [moving], resting: [resting], dx: 4, dy: 0 }), { dx: 1, dy: 0 });
  assert.deepEqual(constrainDrag({ moving: [moving], resting: [], dx: 4, dy: 0 }), { dx: 4, dy: 0 });
  const wall = constrainDrag({ moving: [moving], resting: [], dx: -10, dy: 0 });
  assert.ok(Math.abs(moving.x + wall.dx - 1) < 0.01); // left wall: minX clamped to 0
  assert.deepEqual(constrainDrag({ moving: [moving], resting: [floor], dx: 0, dy: 2 }), { dx: 0, dy: 1 }); // rests on floor top
});

test('dragging onto the platform settles the anchor on top without penetrating', () => {
  const single = {
    ...level(),
    environment: { platformType: 'single-3' },
    castle: [{ id: 'box', x: 4.5, y: 5, angle: 0, shape: { kind: 'box', width: 2, height: 2 }, plugin: { box: true } }],
  };
  const { editor, emit, store } = harness({
    levels: [{ ...single, fileName: 'level-1.json', filePath: 'level/level-1.json' }],
  });
  editor.setMode('edit');

  emit('pointerdown', { clientX: 450, clientY: 500 });
  emit('pointermove', { clientX: 450, clientY: 1150 });
  emit('pointerup', { clientX: 450, clientY: 1150 });

  assert.equal(store.currentLevel.castle[0].x, 4.5);
  assert.equal(store.currentLevel.castle[0].y, 11.34);
});
