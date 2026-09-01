import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createEditorState } from '../static/js/editor-state.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/legacy-level.json', import.meta.url), 'utf8'));

function levelWithUnknowns() {
  const level = structuredClone(fixture);
  level.editorExtension = { author: 'observer', flags: ['legacy'] };
  level.castle[0].pluginData = { lockedBy: 'extension', score: 7 };
  return level;
}

test('selection supports replace, additive, toggle, and box selection without dirtying the level', () => {
  const state = createEditorState(levelWithUnknowns());
  state.dispatch({ type: 'select', ids: ['left-column'] });
  assert.deepEqual(state.selection, ['left-column']);

  state.dispatch({ type: 'select', ids: ['right-column'], mode: 'add' });
  assert.deepEqual(state.selection, ['left-column', 'right-column']);

  state.dispatch({ type: 'select', ids: ['left-column'], mode: 'toggle' });
  assert.deepEqual(state.selection, ['right-column']);

  state.dispatch({ type: 'selectBox', bounds: { left: 3, right: 5, top: 7, bottom: 11 }, mode: 'replace' });
  assert.deepEqual(state.selection, ['left-column', 'middle-block', 'crossbeam', 'roof']);
  assert.equal(state.dirty, false);
  assert.equal(state.canUndo, false);
});

test('box selection uses rotated visual bounds rather than object centers', () => {
  const level = levelWithUnknowns();
  level.castle = [{ ...level.castle[0], id: 'rotated', x: 5, y: 5, angle: Math.PI / 4, shape: { kind: 'box', width: 4, height: 0.5 } }];
  const state = createEditorState(level);
  state.dispatch({ type: 'selectBox', bounds: { left: 3.4, right: 3.8, top: 3.4, bottom: 3.8 } });
  assert.deepEqual(state.selection, ['rotated']);
});

test('inspector patches only changed paths and preserves unknown fields', () => {
  const original = levelWithUnknowns();
  const state = createEditorState(original);
  state.dispatch({ type: 'select', ids: ['left-column'] });
  state.dispatch({ type: 'patchSelected', updates: { name: '左塔柱', x: 3.75 } });

  assert.equal(state.level.castle[0].name, '左塔柱');
  assert.equal(state.level.castle[0].x, 3.75);
  assert.deepEqual(state.level.castle[0].pluginData, original.castle[0].pluginData);
  assert.deepEqual(state.level.editorExtension, original.editorExtension);
  assert.deepEqual(original, levelWithUnknowns(), 'the imported object remains immutable');
});

test('level inspector patches nested metadata without replacing sibling or unknown fields', () => {
  const state = createEditorState(levelWithUnknowns());
  state.dispatch({ type: 'patch', updates: { 'global.gravity': 8.4 } });

  assert.equal(state.level.global.gravity, 8.4);
  assert.equal(state.level.global.initialAmmo, fixture.global.initialAmmo);
  assert.deepEqual(state.level.editorExtension, { author: 'observer', flags: ['legacy'] });
});

test('add creates a selected object and rejects incomplete or duplicate objects', () => {
  const state = createEditorState(levelWithUnknowns());
  const added = { ...structuredClone(fixture.castle[0]), id: 'new-piece', x: 2, y: 4 };
  state.dispatch({ type: 'add', object: added });

  assert.equal(state.level.castle.at(-1).id, 'new-piece');
  assert.deepEqual(state.selection, ['new-piece']);
  assert.equal(state.dirty, true);
  assert.throws(() => state.dispatch({ type: 'add', object: { id: 'incomplete' } }), /complete/i);
  assert.throws(() => state.dispatch({ type: 'add', object: added }), /unique/i);
});

test('duplicate creates unique ids, preserves extensions, and snaps the offset', () => {
  const state = createEditorState(levelWithUnknowns(), { gridSize: 0.25 });
  state.dispatch({ type: 'select', ids: ['left-column'] });
  state.dispatch({ type: 'duplicate', offset: { x: 0.33, y: -0.33 } });

  const copy = state.level.castle.at(-1);
  assert.equal(copy.id, 'left-column-copy');
  assert.equal(copy.x, 3.5);
  assert.equal(copy.y, 9.75);
  assert.deepEqual(copy.pluginData, { lockedBy: 'extension', score: 7 });
  assert.deepEqual(state.selection, ['left-column-copy']);
});

test('delete removes all selected objects and undo restores them and their selection', () => {
  const state = createEditorState(levelWithUnknowns());
  state.dispatch({ type: 'select', ids: ['left-column', 'roof'] });
  state.dispatch({ type: 'delete' });
  assert.equal(state.level.castle.length, fixture.castle.length - 2);
  assert.deepEqual(state.selection, []);

  assert.equal(state.undo(), true);
  assert.equal(state.level.castle.length, fixture.castle.length);
  assert.deepEqual(state.selection, ['left-column', 'roof']);
});

test('move snaps positions to the configured grid and supports keyboard-scale nudges', () => {
  const state = createEditorState(levelWithUnknowns(), { gridSize: 0.25 });
  state.dispatch({ type: 'select', ids: ['left-column'] });
  state.dispatch({ type: 'move', dx: 0.18, dy: 0.37, snap: true });
  assert.deepEqual(
    { x: state.level.castle[0].x, y: state.level.castle[0].y },
    { x: 3.5, y: 10.25 },
  );

  state.dispatch({ type: 'move', dx: -0.25, dy: 0, snap: false });
  assert.equal(state.level.castle[0].x, 3.25);
});

test('alignment places selected centers on an independently known axis value', () => {
  const level = levelWithUnknowns();
  level.castle[0].x = 1;
  level.castle[1].x = 3;
  level.castle[2].x = 8;
  const state = createEditorState(level, { gridSize: 0.25 });
  state.dispatch({ type: 'select', ids: ['left-column', 'right-column', 'middle-block'] });
  state.dispatch({ type: 'align', axis: 'center-x' });

  assert.deepEqual(state.level.castle.slice(0, 3).map((object) => object.x), [3, 3, 3]);
});

test('undo and redo traverse immutable edits and a new branch clears redo', () => {
  const state = createEditorState(levelWithUnknowns());
  state.dispatch({ type: 'patch', updates: { difficulty: 'hard' } });
  const firstEdit = state.level;
  state.dispatch({ type: 'patch', updates: { 'global.gravity': 7 } });
  assert.notStrictEqual(state.level, firstEdit);

  assert.equal(state.undo(), true);
  assert.strictEqual(state.level, firstEdit);
  assert.equal(state.canRedo, true);
  assert.equal(state.redo(), true);
  assert.equal(state.level.global.gravity, 7);

  state.undo();
  state.dispatch({ type: 'patch', updates: { 'global.gravity': 6 } });
  assert.equal(state.canRedo, false);
  assert.equal(state.redo(), false);
});

test('dirty tracking follows the clean revision through undo and redo', () => {
  const state = createEditorState(levelWithUnknowns());
  state.dispatch({ type: 'patch', updates: { difficulty: 'hard' } });
  assert.equal(state.dirty, true);
  state.markClean();
  assert.equal(state.dirty, false);

  state.dispatch({ type: 'patch', updates: { difficulty: 'easy' } });
  assert.equal(state.dirty, true);
  state.undo();
  assert.equal(state.dirty, false);
  state.redo();
  assert.equal(state.dirty, true);
});

test('history is bounded to the configured number of edits', () => {
  const state = createEditorState(levelWithUnknowns(), { historyLimit: 2 });
  state.dispatch({ type: 'patch', updates: { difficulty: 'hard' } });
  state.dispatch({ type: 'patch', updates: { difficulty: 'easy' } });
  state.dispatch({ type: 'patch', updates: { difficulty: 'normal' } });

  assert.equal(state.undo(), true);
  assert.equal(state.undo(), true);
  assert.equal(state.undo(), false);
  assert.equal(state.level.difficulty, 'hard');
});

test('commands that do not change level values do not dirty or add history', () => {
  const state = createEditorState(levelWithUnknowns());
  state.dispatch({ type: 'select', ids: ['left-column'] });
  state.dispatch({ type: 'move', dx: 0, dy: 0, snap: false });
  state.dispatch({ type: 'patchSelected', updates: { x: fixture.castle[0].x } });

  assert.equal(state.dirty, false);
  assert.equal(state.canUndo, false);
});

test('subscribers receive current immutable snapshots after commands and history changes', () => {
  const state = createEditorState(levelWithUnknowns());
  const events = [];
  const unsubscribe = state.subscribe((snapshot) => events.push(snapshot));
  state.dispatch({ type: 'select', ids: ['roof'] });
  state.dispatch({ type: 'patchSelected', updates: { angle: 15 } });
  state.undo();
  unsubscribe();
  state.dispatch({ type: 'select', ids: [] });

  assert.equal(events.length, 3);
  assert.ok(events.every(Object.isFrozen));
  assert.equal(events[1].level.castle.at(-1).angle, 15);
  assert.equal(events[2].level.castle.at(-1).angle, fixture.castle.at(-1).angle);
});
