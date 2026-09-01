import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as editorModule from '../static/js/editor.js';
import { EditorStore } from '../static/js/editor-store.js';
import { createFreeWorldEditor } from '../static/js/free-world-editor.js';
import { decodeLevelDocument } from '../static/js/level-document.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';

const { boot, loadProject } = editorModule;
const unified = decodeGlobalConfig(JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8')));

const [editorCss, editorSource] = await Promise.all([
  readFile(new URL('../static/css/editor.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/js/editor.js', import.meta.url), 'utf8'),
]);

test('editor layout keeps the level-list width and packs runtime fields into compact grids', () => {
  assert.match(editorCss, /grid-template-columns:220px 242px minmax\(420px,1fr\) 286px/);
  for (const width of [190, 170, 160, 150]) {
    assert.doesNotMatch(
      editorCss,
      new RegExp(`\\.workspace\\s*\\{[^}]*grid-template-columns\\s*:\\s*${width}px`, 's'),
      `workspace must not replace its first column with ${width}px`,
    );
  }
  assert.match(editorSource, /fieldsGrid\.className\s*=\s*["']runtime-field-grid field-grid field-grid--three["']/);
  assert.match(editorCss, /\.field-grid--three\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(editorCss, /\.field-span-full\{grid-column:1\/-1\}/);
});

test('latest-template editor entry imports without legacy host APIs', () => {
  assert.equal(typeof boot, 'function');
  assert.equal(typeof loadProject, 'function');
  assert.equal(typeof editorModule.enterCurrentLevelEdit, 'function');
  assert.equal(typeof createFreeWorldEditor, 'function');
});

test('play damage feedback coordinator ingests runtime events and resets session effects', () => {
  const calls = [];
  const effects = {
    ingest(events) { calls.push(['ingest', events]); },
    reset() { calls.push(['reset']); },
  };
  const damageEvents = [{ type: 'destroyed', position: { x: 4, y: 7 } }];

  editorModule.applyPlayDamageFeedback?.(effects, { damageEvents });
  editorModule.resetPlayDamageFeedback?.(effects);

  assert.deepEqual(calls, [['ingest', damageEvents], ['reset']]);
});

test('play damage feedback layout passes the level, canvas, and project config to the game adapter', () => {
  const level = { castle: [] };
  const canvas = { width: 750, height: 1624 };
  const config = {
    canvas: { width: 750, height: 1624 },
    world: { width: 9, height: 16 },
  };

  const layout = editorModule.playDamageFeedbackLayout?.(level, canvas, config);

  assert.equal(layout?.canvasWidth, 750);
  assert.equal(layout?.canvasHeight, 1624);
  assert.equal(layout?.worldWidth, 9);
  assert.equal(layout?.worldHeight, 16);
});

test('play exposes every right-panel configuration without enabling canvas editing scopes', () => {
  const allowed = editorModule.editorMutationAllowed;
  assert.equal(allowed?.({ writable: true, mode: 'edit', scope: 'object' }), true);
  for (const scope of ['object', 'level', 'history', 'asset-library']) {
    assert.equal(allowed?.({ writable: true, mode: 'play', scope }), false, scope);
  }
  for (const scope of ['global-project', 'global-runtime', 'level-config', 'object-config', 'asset-config', 'material']) {
    assert.equal(allowed?.({ writable: true, mode: 'play', scope }), true, scope);
  }
  assert.equal(allowed?.({ writable: false, mode: 'edit', scope: 'global-project' }), false);
  assert.equal(allowed?.({ writable: false, mode: 'edit', scope: 'global-runtime' }), false);
  assert.equal(allowed?.({ writable: false, mode: 'edit', scope: 'material' }), false);
});

test('writable projects allow creating levels in play and edit modes', () => {
  const allowed = editorModule.editorMutationAllowed;
  assert.equal(allowed?.({ writable: true, mode: 'play', scope: 'level-create' }), true);
  assert.equal(allowed?.({ writable: true, mode: 'edit', scope: 'level-create' }), true);
  assert.equal(allowed?.({ writable: false, mode: 'play', scope: 'level-create' }), false);
});

test('creating a level from play opens the new level in edit mode', () => {
  const state = { levels: 1, mode: 'play', tab: 'element' };

  editorModule.createLevelForEditing?.({
    addLevel: () => { state.levels += 1; },
    currentMode: state.mode,
    enterEdit: () => { state.mode = 'edit'; state.tab = 'level'; },
    showLevelTab: () => { state.tab = 'level'; },
  });

  assert.deepEqual(state, { levels: 2, mode: 'edit', tab: 'level' });
});

test('editor intents route to the requested configuration tab', () => {
  assert.equal(editorModule.editorIntentTab?.('enter-edit'), 'level');
  assert.equal(editorModule.editorIntentTab?.('double-click-level'), 'level');
  assert.equal(editorModule.editorIntentTab?.('double-click-object'), 'element');
});

test('object angle controls display degrees and persist radians', () => {
  assert.equal(editorModule.objectAngleDegrees?.(Math.PI / 2), 90);
  assert.ok(Math.abs(editorModule.objectAngleRadians?.('90') - Math.PI / 2) < 1e-12);
  assert.equal(editorModule.objectAngleDegrees?.(undefined), '');
  assert.equal(editorModule.objectAngleRadians?.(''), null);
});

test('play keeps every resource card available for right-panel configuration', () => {
  const allowed = editorModule.resourceCardEditAllowed;
  assert.equal(typeof allowed, 'function');
  assert.equal(allowed({ writable: true, mode: 'play', kind: 'materials' }), true);
  assert.equal(allowed({ writable: true, mode: 'play', kind: 'shapes' }), true);
  assert.equal(allowed({ writable: true, mode: 'edit', kind: 'shapes' }), true);
  assert.equal(allowed({ writable: false, mode: 'edit', kind: 'materials' }), false);
});

test('material resource cards expose safe editable base colors for known and custom procedural previews', () => {
  assert.deepEqual(editorModule.resourceCardVisual?.({ kind: 'materials', id: 'wood', color: '#102030' }), {
    classes: ['asset-visual', 'material-preview'],
    dataset: { material: 'wood' },
    styles: { '--asset-color': '#102030' },
  });
  assert.deepEqual(editorModule.resourceCardVisual?.({ kind: 'materials', id: 'clay', color: '#963' }), {
    classes: ['asset-visual', 'material-preview'],
    dataset: { material: 'clay' },
    styles: { '--asset-color': '#963' },
  });
  assert.deepEqual(editorModule.resourceCardVisual?.({ kind: 'materials', id: 'unsafe', color: 'red; background:url(javascript:1)' }), {
    classes: ['asset-visual', 'material-preview'],
    dataset: { material: 'unsafe' },
    styles: { '--asset-color': '#738096' },
  });
  assert.deepEqual(editorModule.resourceCardVisual?.({ kind: 'shapes', id: 'square' }), {
    classes: ['asset-visual'],
    dataset: {},
    styles: {},
  });
});

test('asset drag preview uses the real resource geometry without mutating the level', () => {
  const level = { castle: [] };
  const assets = {
    materials: { wood: { id: 'wood', name: '木材' } },
    shapes: { beam: { id: 'beam', name: '长梁', shape: { kind: 'box', width: 2.4, height: 0.35 } } },
    specialObjects: {},
  };

  const preview = editorModule.createAssetDragPreview?.({
    level, assets, kind: 'shapes', id: 'beam', point: { x: 4.25, y: 6.5 },
  });

  assert.deepEqual(preview?.shape, { kind: 'box', width: 2.4, height: 0.35 });
  assert.equal(preview?.x, 4.25);
  assert.equal(preview?.y, 6.5);
  assert.deepEqual(level, { castle: [] });
});

test('resource dragging replaces the native card ghost with a transparent one-pixel image', () => {
  const calls = [];
  const body = { append(node) { calls.push(['append', node]); } };
  const documentRef = {
    body,
    createElement(tag) {
      return { tag, width: 0, height: 0, style: {}, remove() { calls.push(['remove']); } };
    },
  };
  const dataTransfer = { setDragImage(node, x, y) { calls.push(['setDragImage', node, x, y]); } };

  const image = editorModule.suppressNativeDragPreview?.(dataTransfer, documentRef, () => {});

  assert.equal(image?.tag, 'canvas');
  assert.equal(image?.width, 1);
  assert.equal(image?.height, 1);
  assert.deepEqual(calls[1], ['setDragImage', image, 0, 0]);
});

test('frozen-body action controls can be created during editor initialization', () => {
  const documentRef = {
    createElement(tagName) {
      return {
        tagName,
        children: [],
        append(...children) { this.children.push(...children); },
      };
    },
  };

  const controls = editorModule.createFrozenActionControls(documentRef);

  assert.equal(controls.tagName, 'div');
  assert.equal(controls.className, 'field-row frozen-actions');
  assert.deepEqual(controls.children.map(({ id, textContent }) => ({ id, textContent })), [
    { id: 'create-frozen-body', textContent: '包裹为冰冻体' },
    { id: 'remove-frozen-body', textContent: '解除冰冻体' },
  ]);
});

test('projectile drawable circles are doubled without changing runtime bodies or other circles', () => {
  const runtimeBody = Object.freeze({
    kind: 'meteor',
    radius: 0.2,
    shape: Object.freeze({ kind: 'circle', radius: 0.2 }),
  });

  assert.deepEqual(editorModule.projectileVisualShape?.(runtimeBody), { kind: 'circle', radius: 0.4 });
  assert.deepEqual(runtimeBody, {
    kind: 'meteor',
    radius: 0.2,
    shape: { kind: 'circle', radius: 0.2 },
  });
  assert.deepEqual(
    editorModule.projectileVisualShape?.({ kind: 'body', radius: 0.2, shape: { kind: 'circle', radius: 0.2 } }),
    { kind: 'circle', radius: 0.2 },
  );
  assert.deepEqual(
    editorModule.projectileVisualShape?.({ meteorType: 'normal', radius: 0.2 }, { shape: { kind: 'circle', radius: 0.3 } }),
    { kind: 'circle', radius: 0.4 },
  );
});

test('playLevel updates an authored member from its runtime snapshot without mutating the draft', () => {
  const draft = {
    castle: [{
      id: 'target-1', x: 1, y: 2, angle: 0, materialId: 'wood',
      shape: { kind: 'box', width: 1, height: 0.5 },
    }],
  };
  const before = structuredClone(draft);
  const rendered = editorModule.playLevel?.(draft, {
    bodies: [{
      id: 'target-1', kind: 'body', position: { x: 4, y: 5 }, angle: 0.25,
      shape: { kind: 'box', width: 1, height: 0.5 },
    }],
  });

  assert.deepEqual(rendered?.castle.map(({ id, kind, x, y, angle, shape }) => ({
    id, kind, x, y, angle, shape,
  })), [{
    id: 'target-1', kind: 'body', x: 4, y: 5, angle: 0.25,
    shape: { kind: 'box', width: 1, height: 0.5 },
  }]);
  assert.deepEqual(draft, before);
});

test('playLevel keeps authored member snapshots while excluding runtime-only physics proxies', () => {
  const draft = {
    castle: [
      { id: 'frozen-member', x: 1, y: 2, angle: 0, shape: { kind: 'box', width: 1, height: 0.5 } },
      { id: 'ordinary-target', x: 3, y: 4, angle: 0, shape: { kind: 'circle', radius: 0.3 } },
    ],
    frozenBodies: [{ id: 'ice-1', memberIds: ['frozen-member'] }],
  };
  const snapshot = {
    bodies: [
      {
        id: 'frozen-member', kind: 'body', position: { x: 1, y: 2 }, angle: 0,
        shape: { kind: 'box', width: 1, height: 0.5 },
      },
      {
        id: 'ordinary-target', kind: 'body', position: { x: 7, y: 8 }, angle: 0.2,
        shape: { kind: 'circle', radius: 0.3 },
      },
      {
        id: 'ice-1', kind: 'frozen-body', position: { x: 5, y: 6 }, angle: 0.4,
        shape: { kind: 'compound', memberIds: ['frozen-member'] },
      },
      { id: 'runtime-helper', kind: 'body', position: { x: 2, y: 3 }, shape: { kind: 'circle', radius: 0.1 } },
    ],
    frozenBodies: [{
      id: 'ice-1', memberIds: ['frozen-member'], state: 'cracked', hitPoint: { x: 5, y: 6 },
      memberTransforms: [{ id: 'frozen-member', x: 5, y: 6, angle: 0.4 }],
    }],
  };

  const rendered = editorModule.playLevel(draft, snapshot);

  assert.deepEqual(rendered.castle.map(({ id }) => id), ['frozen-member', 'ordinary-target']);
  assert.deepEqual(rendered.castle.map(({ x, y }) => ({ x, y })), [{ x: 5, y: 6 }, { x: 7, y: 8 }]);
  assert.equal(rendered.castle.some(object => object.shape.kind === 'compound'), false);
  assert.deepEqual(snapshot.frozenBodies, [{
    id: 'ice-1', memberIds: ['frozen-member'], state: 'cracked', hitPoint: { x: 5, y: 6 },
    memberTransforms: [{ id: 'frozen-member', x: 5, y: 6, angle: 0.4 }],
  }]);

  const released = editorModule.playLevel(draft, {
    bodies: [{
      id: 'frozen-member', kind: 'body', position: { x: 8, y: 9 }, angle: 0.7,
      shape: { kind: 'box', width: 1, height: 0.5 },
    }],
    frozenBodies: [{
      id: 'ice-1', memberIds: ['frozen-member'], state: 'released',
      memberTransforms: [{ id: 'frozen-member', x: 5, y: 6, angle: 0.4 }],
    }],
  });
  assert.deepEqual(
    released.castle.map(({ id, x, y, angle }) => ({ id, x, y, angle })),
    [{ id: 'frozen-member', x: 8, y: 9, angle: 0.7 }],
  );
});

test('play input is revalidated and field errors are attached without mutating controls', async () => {
  const { config, assets } = structuredClone(unified);
  const level = decodeLevelDocument(JSON.parse(await readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8')), assets);
  level.castle[0].mass = 0;

  assert.throws(
    () => editorModule.validatePlayInput?.({ config, assets, level }),
    error => error?.code === 'LEVEL_INVALID' && error.details.path === `castle.${level.castle[0].id}.mass`,
  );

  const attributes = new Map();
  const input = {
    value: '-1',
    setCustomValidity(message) { this.validationMessage = message; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
  editorModule.setFieldError?.(input, { message: '质量必须大于 0' });
  assert.equal(input.value, '-1');
  assert.equal(input.validationMessage, '质量必须大于 0');
  assert.equal(attributes.get('aria-invalid'), 'true');
  editorModule.setFieldError?.(input, null);
  assert.equal(input.validationMessage, '');
  assert.equal(attributes.has('aria-invalid'), false);
});

test('level field edits use typed values and dirty only the selected level', async () => {
  const { config, assets } = structuredClone(unified);
  const source = JSON.parse(await readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  const level = decodeLevelDocument(source, assets);
  level.filePath = 'level/original-01-level-01.json';
  const store = new EditorStore({ config, assets, levels: [level] });

  const result = editorModule.applyLevelFieldChange({
    editorStore: store,
    fieldId: 'normalAmmo',
    rawValue: '6',
  });

  assert.equal(result.ok, true);
  assert.equal(store.currentLevel.normalAmmo, 6);
  assert.deepEqual([...store.dirtyLevelPaths], ['level/original-01-level-01.json']);
  assert.equal(store.configDirty, false);
  assert.equal(store.config.runtime.global.initialAmmo, 15);
  assert.equal(store.config.runtime.global.explosiveAmmo, 1);

  const invalid = editorModule.applyLevelFieldChange({
    editorStore: store,
    fieldId: 'explosiveAmmo',
    rawValue: '-1',
  });
  assert.equal(invalid.ok, false);
  assert.equal(store.currentLevel.explosiveAmmo, 1);
});

test('replacing level extensions can delete old keys without touching authored fields or metadata', async () => {
  const { config, assets } = structuredClone(unified);
  const source = JSON.parse(await readFile(new URL('../level/关卡-001-直射引导.json', import.meta.url), 'utf8'));
  const level = decodeLevelDocument(source, assets);
  level.filePath = 'level/original-01-level-01.json';
  level.bonus = 3;
  const originalCastle = structuredClone(level.castle);
  const originalMetadata = structuredClone(level.__levelDocument);
  const store = new EditorStore({ config, assets, levels: [level] });

  store.replaceLevelExtensions({ wave: 2 });

  assert.equal(Object.hasOwn(store.currentLevel, 'bonus'), false);
  assert.equal(store.currentLevel.wave, 2);
  assert.deepEqual(store.currentLevel.castle, originalCastle);
  assert.deepEqual(store.currentLevel.__levelDocument, originalMetadata);
  assert.deepEqual([...store.dirtyLevelPaths], ['level/original-01-level-01.json']);
});
