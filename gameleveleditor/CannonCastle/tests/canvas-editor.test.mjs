import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CanvasEditor } from '../static/js/canvas-editor.js';
import { createEditorState } from '../static/js/editor-state.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/legacy-level.json', import.meta.url), 'utf8'));

function harness({ ratio = 2 } = {}) {
  const listeners = new Map();
  const calls = [];
  const context = new Proxy({}, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === 'string') return (...args) => calls.push([property, ...args]);
    },
    set(target, property, value) { target[property] = value; return true; },
  });
  const browser = { devicePixelRatio: ratio, addEventListener() {}, removeEventListener() {} };
  const canvas = {
    ownerDocument: { defaultView: browser }, width: 0, height: 0,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    setAttribute() {}, focus() {}, setPointerCapture() {}, releasePointerCapture() {},
    getContext() { return context; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; },
  };
  const state = createEditorState(structuredClone(fixture));
  const editor = new CanvasEditor(canvas, state, { scale: 10, gridSize: 0.25 });
  const event = (overrides = {}) => ({
    button: 0, pointerId: 1, clientX: 32, clientY: 100, deltaY: 0, key: '',
    preventDefault() {}, ...overrides,
  });
  return { editor, state, canvas, calls, emit: (name, overrides) => listeners.get(name)(event(overrides)) };
}

test('pointer drag commits once while pointer cancel restores selection and commits nothing', () => {
  const { state, emit } = harness();
  emit('pointerdown');
  emit('pointermove', { clientX: 42, clientY: 100 });
  emit('pointercancel', { clientX: 42, clientY: 100 });
  assert.equal(state.level.castle[0].x, fixture.castle[0].x);
  assert.equal(state.canUndo, false);
  assert.deepEqual(state.selection, []);

  emit('pointerdown');
  emit('pointermove', { clientX: 42, clientY: 100 });
  emit('pointerup', { clientX: 42, clientY: 100 });
  assert.equal(state.level.castle[0].x, 4.25);
  assert.equal(state.canUndo, true);
  assert.equal(state.undo(), true);
  assert.equal(state.level.castle[0].x, fixture.castle[0].x);
  assert.equal(state.undo(), false, 'one pointer drag must create exactly one history command');
});

test('click selects the topmost hit object and modifier click builds a multi-selection', () => {
  const { state, emit } = harness();
  emit('pointerdown', { clientX: 32, clientY: 100 });
  emit('pointerup', { clientX: 32, clientY: 100 });
  assert.deepEqual(state.selection, ['left-column']);

  emit('pointerdown', { clientX: 58, clientY: 100, shiftKey: true });
  emit('pointerup', { clientX: 58, clientY: 100, shiftKey: true });
  assert.deepEqual(state.selection, ['left-column', 'right-column']);
  assert.equal(state.dirty, false);
});

test('committed marquee selects intersecting objects through pointer events', () => {
  const { state, emit } = harness();
  emit('pointerdown', { clientX: 25, clientY: 75 });
  emit('pointermove', { clientX: 65, clientY: 112 });
  emit('pointerup', { clientX: 65, clientY: 112 });

  assert.deepEqual(state.selection, ['left-column', 'right-column', 'middle-block', 'crossbeam', 'roof']);
  assert.equal(state.dirty, false);
});

test('cancelled box selection restores the pre-gesture selection', () => {
  const { state, emit } = harness();
  state.dispatch({ type: 'select', ids: ['roof'] });
  emit('pointerdown', { clientX: 300, clientY: 250 });
  assert.deepEqual(state.selection, []);
  emit('pointermove', { clientX: 10, clientY: 10 });
  emit('pointercancel', { clientX: 10, clientY: 10 });
  assert.deepEqual(state.selection, ['roof']);
  assert.equal(state.dirty, false);
});

test('pan cancel restores viewport and wheel zoom keeps the cursor world anchor fixed', () => {
  const { editor, emit } = harness();
  emit('pointerdown', { button: 1, clientX: 100, clientY: 80 });
  emit('pointermove', { button: 1, clientX: 140, clientY: 110 });
  assert.deepEqual(editor.viewport, { x: 40, y: 30, zoom: 1 });
  emit('pointercancel', { button: 1, clientX: 140, clientY: 110 });
  assert.deepEqual(editor.viewport, { x: 0, y: 0, zoom: 1 });

  const before = editor.worldFromEvent({ clientX: 120, clientY: 90 });
  emit('wheel', { clientX: 120, clientY: 90, deltaY: -200 });
  const after = editor.worldFromEvent({ clientX: 120, clientY: 90 });
  assert.ok(editor.viewport.zoom > 1);
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('render uses a high-DPI backing buffer and device pixel transform', () => {
  const { canvas, calls } = harness({ ratio: 2 });
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 600);
  assert.ok(calls.some((call) => call[0] === 'setTransform' && call[1] === 2 && call[4] === 2));
});

test('render emits the selected-object overlay stroke signal', () => {
  const { editor, state, calls } = harness();
  state.dispatch({ type: 'select', ids: ['left-column'] });
  calls.length = 0;
  editor.render();

  assert.ok(calls.some((call) => call[0] === 'setLineDash' && call[1][0] === 0.08));
  assert.ok(calls.some((call) => call[0] === 'strokeRect'), 'selection overlay must draw its outline');
});

test('play mode maps pointer coordinates to the original 9 by 16 world and fires immediately', () => {
  const { editor, emit } = harness();
  const calls = [];
  editor.setPlayInteraction({
    aimAt(point) { calls.push(['aimAt', point]); return true; },
    fireAt(point) { calls.push(['fireAt', point]); return 'fired'; },
  });
  editor.setMode('play', { bodies: [], projectiles: [] });

  emit('pointermove', { clientX: 200, clientY: 75 });
  emit('pointerdown', { clientX: 200, clientY: 75 });

  assert.deepEqual(calls, [
    ['aimAt', { x: 4.5, y: 4 }],
    ['fireAt', { x: 4.5, y: 4 }],
  ]);
});

test('keyboard supports nudge, duplicate, delete, undo, and redo', () => {
  const { state, emit } = harness();
  state.dispatch({ type: 'select', ids: ['left-column'] });
  emit('keydown', { key: 'ArrowRight' });
  assert.equal(state.level.castle[0].x, fixture.castle[0].x + 0.25);
  emit('keydown', { key: 'd', ctrlKey: true });
  assert.equal(state.level.castle.length, fixture.castle.length + 1);
  emit('keydown', { key: 'Delete' });
  assert.equal(state.level.castle.length, fixture.castle.length);
  emit('keydown', { key: 'z', ctrlKey: true });
  assert.equal(state.level.castle.length, fixture.castle.length + 1);
  emit('keydown', { key: 'z', ctrlKey: true, shiftKey: true });
  assert.equal(state.level.castle.length, fixture.castle.length);
});

test('play and debug modes disable edit gestures and restore selection and viewport on exit', () => {
  const { editor, state, emit } = harness();
  state.dispatch({ type: 'select', ids: ['roof'] });
  editor.viewport = { x: 13, y: 21, zoom: 1.4 };
  const editContext = editor.captureEditContext();

  editor.setMode('play', {
    phase: 'playing', normalAmmo: 2, explosiveAmmo: 1,
    castle: structuredClone(fixture.castle), projectiles: [], explosionEvents: [],
  });
  emit('pointerdown', { clientX: 32, clientY: 100 });
  emit('pointerup', { clientX: 62, clientY: 100 });
  emit('keydown', { key: 'Delete' });
  assert.deepEqual(state.selection, ['roof']);
  assert.equal(state.level.castle.length, fixture.castle.length);

  editor.setMode('debug', {
    phase: 'playing', normalAmmo: 2, explosiveAmmo: 1,
    castle: [{ ...structuredClone(fixture.castle[0]), hp: 2, velocity: { x: 3, y: -1 } }],
    projectiles: [], explosionEvents: [{ position: { x: 3, y: 4 }, radius: 2 }],
  });
  editor.restoreEditContext(editContext);
  editor.setMode('edit');
  assert.deepEqual(state.selection, ['roof']);
  assert.deepEqual(editor.viewport, { x: 13, y: 21, zoom: 1.4 });
});

test('debug rendering emits ID, HP, velocity, collision-shape, and explosion-radius overlays', () => {
  const { editor, calls } = harness();
  calls.length = 0;
  editor.setMode('debug', {
    phase: 'playing', normalAmmo: 1, explosiveAmmo: 0,
    castle: [{ ...structuredClone(fixture.castle[0]), hp: 2, velocity: { x: 3, y: -1 } }],
    projectiles: [], explosionEvents: [{ position: { x: 3, y: 4 }, radius: 2 }],
  });

  const labels = calls.filter((call) => call[0] === 'fillText').map((call) => call[1]);
  assert.ok(labels.some((label) => label.includes('left-column')));
  assert.ok(labels.some((label) => label.includes('HP 2')));
  assert.ok(labels.some((label) => label.includes('v 3.00,-1.00')));
  assert.ok(calls.some((call) => call[0] === 'setLineDash'), 'collision shape must use a diagnostic dash');
  assert.ok(calls.some((call) => call[0] === 'arc' && call[3] === 2), 'explosion radius must be drawn');
});
