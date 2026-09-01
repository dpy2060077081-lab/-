import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLevel } from '../gamelogic.js';
import { EditorStore } from '../static/js/editor-store.js';
import { assets, config, globalDocument, readExportedLevel } from './project-config-fixture.mjs';

const baseDocument = await readExportedLevel('关卡-001-直射引导.json');

const piece = (id, x, extra = {}) => ({
  id,
  name: id,
  x,
  y: 10,
  angle: 0,
  shapePresetId: 'rectangle',
  materialId: 'wood',
  ...extra,
});

function createStore({ frozenBodies = [], castle = null } = {}) {
  const document = structuredClone(baseDocument);
  document.level.castle = castle ?? [
    piece('left', 2),
    piece('right', 2.82),
    piece('far', 6),
    piece('bolt', 3.64, { fixedBolt: true }),
  ];
  document.level.frozenBodies = structuredClone(frozenBodies);
  return new EditorStore({
    globalDocument,
    config,
    assets,
    levels: [document],
  });
}

function createMixedStore() {
  return createStore({
    castle: [
      piece('a-left', 1),
      piece('a-right', 1.82),
      piece('b-left', 4),
      piece('b-right', 4.82),
      piece('solo', 7),
    ],
    frozenBodies: [
      { id: 'ice-a', memberIds: ['a-left', 'a-right'] },
      { id: 'ice-b', memberIds: ['b-left', 'b-right'] },
    ],
  });
}

function ids(value) {
  return [...value].sort();
}

function assertCurrentLevelValid(store) {
  const result = validateLevel(store.currentLevel, store.assets);
  assert.equal(result.ok, true, result.errors.map(error => `${error.path}: ${error.message}`).join('\n'));
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, received ${actual}`);
}

test('selecting or updating one frozen member expands the operation to the complete group', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });

  store.selectObjects(['right']);
  assert.deepEqual(ids(store.selectedObjectIds), ['left', 'right']);
  assert.equal(store.dirty, false);

  store.updateObjects(['left'], object => ({ ...object, x: object.x + 1 }));
  const positions = Object.fromEntries(store.currentLevel.castle.map(object => [object.id, object.x]));
  assert.deepEqual(positions, { left: 3, right: 3.82, far: 6, bolt: 3.64 });
  assertCurrentLevelValid(store);
});

test('rotateObjects rotates each frozen group around its member center while a plain object only changes angle', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });

  store.rotateObjects(['left', 'far'], Math.PI / 2);

  const byId = new Map(store.currentLevel.castle.map(object => [object.id, object]));
  assertClose(byId.get('left').x, 2.41, 'left x');
  assertClose(byId.get('left').y, 9.59, 'left y');
  assertClose(byId.get('right').x, 2.41, 'right x');
  assertClose(byId.get('right').y, 10.41, 'right y');
  assertClose(byId.get('left').angle, Math.PI / 2, 'left angle');
  assertClose(byId.get('right').angle, Math.PI / 2, 'right angle');
  assert.deepEqual(
    { x: byId.get('far').x, y: byId.get('far').y, angle: byId.get('far').angle },
    { x: 6, y: 10, angle: Math.PI / 2 },
  );
  assertCurrentLevelValid(store);
});

test('createFrozenBody atomically creates an adjacent group and undo/redo restore it', () => {
  const store = createStore();
  store.selectObjects(['left', 'right']);

  const groupId = store.createFrozenBody();
  assert.equal(typeof groupId, 'string');
  assert.deepEqual(store.currentLevel.frozenBodies, [{ id: groupId, memberIds: ['left', 'right'] }]);
  assert.deepEqual(ids(store.selectedObjectIds), ['left', 'right']);
  assert.equal(store.dirty, true);
  assertCurrentLevelValid(store);

  assert.equal(store.undo(), true);
  assert.deepEqual(store.currentLevel.frozenBodies, []);
  assert.deepEqual(ids(store.selectedObjectIds), ['left', 'right']);
  assertCurrentLevelValid(store);

  assert.equal(store.redo(), true);
  assert.deepEqual(store.currentLevel.frozenBodies, [{ id: groupId, memberIds: ['left', 'right'] }]);
  assert.deepEqual(ids(store.selectedObjectIds), ['left', 'right']);
  assertCurrentLevelValid(store);
});

test('createFrozenBody rejects disconnected, fixed-bolt, and grouped members without dirtying', () => {
  const cases = [
    { name: 'disconnected', store: createStore(), selected: ['left', 'far'] },
    { name: 'fixed bolt', store: createStore(), selected: ['right', 'bolt'] },
    {
      name: 'already grouped',
      store: createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] }),
      selected: ['left'],
    },
  ];

  for (const entry of cases) {
    const before = entry.store.snapshot();
    assert.throws(() => entry.store.createFrozenBody(entry.selected), undefined, entry.name);
    assert.deepEqual(entry.store.snapshot(), before, entry.name);
    assert.equal(entry.store.dirty, false, entry.name);
    assert.equal(entry.store.undo(), false, entry.name);
    assertCurrentLevelValid(entry.store);
  }
});

test('removeFrozenBodies removes only the group and supports undo/redo', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });
  const originalMembers = structuredClone(store.currentLevel.castle);

  assert.equal(store.removeFrozenBodies(['right']), true);
  assert.deepEqual(store.currentLevel.frozenBodies, []);
  assert.deepEqual(store.currentLevel.castle, originalMembers);
  assertCurrentLevelValid(store);

  assert.equal(store.undo(), true);
  assert.deepEqual(store.currentLevel.frozenBodies, [{ id: 'ice-original', memberIds: ['left', 'right'] }]);
  assert.deepEqual(store.currentLevel.castle, originalMembers);

  assert.equal(store.redo(), true);
  assert.deepEqual(store.currentLevel.frozenBodies, []);
  assert.deepEqual(store.currentLevel.castle, originalMembers);
  assertCurrentLevelValid(store);
});

test('moving a frozen member records one undoable and redoable complete-group change', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });
  store.selectObjects(['left']);
  const before = store.snapshot();

  store.updateObjects(['left'], object => ({ ...object, y: object.y - 1 }));
  const after = store.snapshot();
  assert.deepEqual(after.levels[0].castle.slice(0, 2).map(object => object.y), [9, 9]);

  assert.equal(store.undo(), true);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.snapshot(), after);
});

test('rotating a frozen member atomically restores positions, angles, group, and selection through undo/redo', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });
  store.selectObjects(['right']);
  const before = store.snapshot();

  store.rotateObjects(['right'], Math.PI / 2);
  const after = store.snapshot();

  assert.equal(store.undo(), true);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.snapshot(), after);
});

test('deleteObjects removes the complete frozen group when given one member', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });

  store.deleteObjects(['right']);

  assert.deepEqual(store.currentLevel.castle.map(object => object.id), ['far', 'bolt']);
  assert.deepEqual(store.currentLevel.frozenBodies, []);
  assert.deepEqual(store.selectedObjectIds, []);
  assertCurrentLevelValid(store);
});

test('deleting a frozen member atomically restores castle, group, and selection through undo/redo', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });
  store.selectObjects(['left']);
  const before = store.snapshot();

  store.deleteObjects(['left']);
  const after = store.snapshot();

  assert.equal(store.undo(), true);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.snapshot(), after);
});

test('duplicateObjects copies a complete frozen group and rewrites its member ids', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });
  const originalGroup = structuredClone(store.currentLevel.frozenBodies[0]);

  store.duplicateObjects(['left'], { x: 0, y: -2 });

  const copies = store.currentLevel.castle.filter(object => object.id.endsWith('-copy'));
  assert.deepEqual(copies.map(object => object.id), ['left-copy', 'right-copy']);
  assert.deepEqual(copies.map(object => [object.x, object.y]), [[2, 8], [2.82, 8]]);
  assert.equal(store.currentLevel.frozenBodies.length, 2);
  assert.deepEqual(store.currentLevel.frozenBodies[0], originalGroup);
  const copiedGroup = store.currentLevel.frozenBodies[1];
  assert.notEqual(copiedGroup.id, originalGroup.id);
  assert.deepEqual(copiedGroup.memberIds, ['left-copy', 'right-copy']);
  assert.deepEqual(ids(store.selectedObjectIds), ['left-copy', 'right-copy']);
  assertCurrentLevelValid(store);
});

test('duplicating a frozen member atomically restores castle, frozenBodies, and selection through undo/redo', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });
  store.selectObjects(['right']);
  const before = store.snapshot();

  store.duplicateObjects(['right'], { x: 0, y: -2 });
  const after = store.snapshot();
  assert.equal(after.levels[0].castle.length, before.levels[0].castle.length + 2);
  assert.equal(after.levels[0].frozenBodies.length, before.levels[0].frozenBodies.length + 1);
  assert.deepEqual(ids(after.selectedObjectIds), ['left-copy', 'right-copy']);

  assert.equal(store.undo(), true);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.snapshot(), after);
});

test('mixed selection moves both complete frozen groups and the plain object', () => {
  const store = createMixedStore();

  store.updateObjects(['a-left', 'b-right', 'solo'], object => ({ ...object, x: object.x + 0.25, y: object.y - 0.5 }));

  const moved = store.currentLevel.castle;
  assert.deepEqual(moved.map(object => object.id), ['a-left', 'a-right', 'b-left', 'b-right', 'solo']);
  [1.25, 2.07, 4.25, 5.07, 7.25].forEach((expected, index) => assertClose(moved[index].x, expected, `${moved[index].id} x`));
  moved.forEach(object => assertClose(object.y, 9.5, `${object.id} y`));
  assertCurrentLevelValid(store);
});

test('mixed selection deletes both complete frozen groups and the plain object', () => {
  const store = createMixedStore();

  store.deleteObjects(['a-right', 'b-left', 'solo']);

  assert.deepEqual(store.currentLevel.castle, []);
  assert.deepEqual(store.currentLevel.frozenBodies, []);
  assertCurrentLevelValid(store);
});

test('mixed selection duplicates two independent frozen groups without grouping the plain object', () => {
  const store = createMixedStore();

  store.duplicateObjects(['a-left', 'b-right', 'solo'], { x: 0, y: -2 });

  assert.deepEqual(store.currentLevel.frozenBodies.slice(0, 2), [
    { id: 'ice-a', memberIds: ['a-left', 'a-right'] },
    { id: 'ice-b', memberIds: ['b-left', 'b-right'] },
  ]);
  const copiedGroups = store.currentLevel.frozenBodies.slice(2);
  assert.equal(copiedGroups.length, 2);
  assert.equal(new Set(copiedGroups.map(group => group.id)).size, 2);
  assert.ok(copiedGroups.every(group => !['ice-a', 'ice-b'].includes(group.id)));
  assert.deepEqual(copiedGroups.map(group => group.memberIds), [
    ['a-left-copy', 'a-right-copy'],
    ['b-left-copy', 'b-right-copy'],
  ]);
  const groupedCopies = copiedGroups.flatMap(group => group.memberIds);
  assert.equal(new Set(groupedCopies).size, 4);
  assert.equal(groupedCopies.includes('solo-copy'), false);
  assert.deepEqual(ids(store.selectedObjectIds), [
    'a-left-copy',
    'a-right-copy',
    'b-left-copy',
    'b-right-copy',
    'solo-copy',
  ]);
  assertCurrentLevelValid(store);
});

test('duplicateObjects increments ids when the base -copy ids already exist', () => {
  const store = createStore({
    castle: [
      piece('left', 2),
      piece('right', 2.82),
      piece('left-copy', 5),
      piece('right-copy', 6),
    ],
    frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }],
  });

  store.duplicateObjects(['left'], { x: 0, y: -2 });

  assert.deepEqual(ids(store.selectedObjectIds), ['left-copy-2', 'right-copy-2']);
  assert.deepEqual(store.currentLevel.frozenBodies[1].memberIds, ['left-copy-2', 'right-copy-2']);
  assertCurrentLevelValid(store);
});

test('pasteObjects preserves only complete internal frozen groups without mutating its payload', () => {
  const store = createStore({
    castle: [piece('existing', 8)],
    frozenBodies: [],
  });
  const clipboard = {
    objects: [
      piece('left', 2),
      piece('right', 2.82),
      piece('partial', 5),
      piece('solo', 7),
    ],
    frozenBodies: [
      { id: 'ice-complete', memberIds: ['left', 'right'] },
      { id: 'ice-incomplete', memberIds: ['partial', 'outside'] },
    ],
  };
  const originalClipboard = structuredClone(clipboard);

  store.pasteObjects(clipboard, { x: 0, y: -2 });

  assert.deepEqual(clipboard, originalClipboard);
  assert.deepEqual(ids(store.selectedObjectIds), ['left-copy', 'partial-copy', 'right-copy', 'solo-copy']);
  assert.equal(store.currentLevel.frozenBodies.length, 1);
  assert.notEqual(store.currentLevel.frozenBodies[0].id, 'ice-complete');
  assert.deepEqual(store.currentLevel.frozenBodies[0].memberIds, ['left-copy', 'right-copy']);
  assert.equal(store.currentLevel.frozenBodies[0].memberIds.includes('partial-copy'), false);
  assert.equal(store.currentLevel.frozenBodies[0].memberIds.includes('solo-copy'), false);
  assertCurrentLevelValid(store);
});

test('pasting a structured frozen group is one undoable and redoable change', () => {
  const store = createStore({ frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }] });
  const clipboard = {
    objects: store.currentLevel.castle.filter(object => ['left', 'right'].includes(object.id)),
    frozenBodies: [{ id: 'ice-original', memberIds: ['left', 'right'] }],
  };
  const before = store.snapshot();

  store.pasteObjects(clipboard, { x: 0, y: -2 });
  const after = store.snapshot();

  assert.equal(after.levels[0].castle.length, before.levels[0].castle.length + 2);
  assert.equal(after.levels[0].frozenBodies.length, before.levels[0].frozenBodies.length + 1);
  assert.notEqual(after.levels[0].frozenBodies[1].id, 'ice-original');
  assert.deepEqual(after.levels[0].frozenBodies[1].memberIds, ['left-copy', 'right-copy']);
  assert.deepEqual(ids(after.selectedObjectIds), ['left-copy', 'right-copy']);

  assert.equal(store.undo(), true);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.snapshot(), after);
});

test('editor frozen-body operations do not mutate constructor input, id arrays, or history snapshots', () => {
  const document = structuredClone(baseDocument);
  document.level.castle = [piece('left', 2), piece('right', 2.82)];
  document.level.frozenBodies = [{ id: 'ice-original', memberIds: ['left', 'right'] }];
  const originalDocument = structuredClone(document);
  const requestedIds = ['left'];
  const store = new EditorStore({ globalDocument, config, assets, levels: [document] });
  const beforeUpdate = store.snapshot();

  store.updateObjects(requestedIds, object => ({ ...object, y: object.y - 1 }));
  store.duplicateObjects(requestedIds, { x: 0, y: -2 });

  assert.deepEqual(document, originalDocument);
  assert.deepEqual(requestedIds, ['left']);
  assert.deepEqual(beforeUpdate.levels[0].castle.map(object => object.y), [10, 10]);
  assert.deepEqual(beforeUpdate.levels[0].frozenBodies, [{ id: 'ice-original', memberIds: ['left', 'right'] }]);
  assertCurrentLevelValid(store);
});
