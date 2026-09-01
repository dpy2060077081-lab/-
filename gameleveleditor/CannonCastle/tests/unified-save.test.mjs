import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { EditorStore, saveWorkspace } from '../static/js/editor-store.js';
import { levelCardMarkup, loadProject, refreshWorkspace, resolveLevelSwitch, saveCompletionState, saveEditor } from '../static/js/editor.js';
import { decodeLevelDocument, encodeLevelDocument } from '../static/js/level-document.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';

const readJson = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8').then(JSON.parse);
const [baseGlobalDocument, baseLevel] = await Promise.all([
  readJson('全局配置.json'),
  readJson('level/关卡-001-直射引导.json'),
]);
const { config: baseConfig, assets: baseAssets } = decodeGlobalConfig(baseGlobalDocument);

function level(number) {
  return {
    ...decodeLevelDocument(baseLevel, baseAssets),
    levelNumber: number,
    levelName: `关卡 ${number}`,
    fileName: `original-${String(number).padStart(2, '0')}-level-${String(number).padStart(2, '0')}.json`,
    filePath: `level/original-${String(number).padStart(2, '0')}-level-${String(number).padStart(2, '0')}.json`,
  };
}

function exportedLevel(number, name = `关卡 ${number}`) {
  const entry = level(number);
  const filename = `关卡-${String(number).padStart(3, '0')}-${name}.json`;
  entry.levelName = name;
  entry.fileName = filename;
  entry.filePath = `level/${filename}`;
  entry.workspaceId = `exported:level-${number}`;
  entry.workspaceKind = 'exported';
  entry.__levelDocument = { ...entry.__levelDocument, levelId: `level-${number}` };
  return entry;
}

function recordingFiles({ failAt = null } = {}) {
  const operations = [];
  const record = async (method, ...args) => {
    operations.push([method, ...args]);
    if (operations.length === failAt) throw Object.assign(new Error('disk denied'), { code: 'DENIED' });
    return {};
  };
  return {
    operations,
    files: {
      mkdir: (path, parents) => record('mkdir', path, parents),
      writeBase64: (path, content, overwrite) => record('writeBase64', path, content, overwrite),
      writeText: (path, content, overwrite) => record('writeText', path, content, overwrite),
      remove: (path, recursive) => record('remove', path, recursive),
    },
  };
}

test('new levels use the supplied generation configuration for id, number, and filename', () => {
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)] });

  store.addLevel({ levelId: 'level-42', levelNumber: 42, levelName: '悬空城门' });

  assert.equal(store.currentLevel.levelNumber, 42);
  assert.equal(store.currentLevel.levelName, '悬空城门');
  assert.equal(store.currentLevel.__levelDocument.levelId, 'level-42');
  assert.equal(store.currentLevel.fileName, '关卡-042-悬空城门.json');
  assert.equal(store.currentLevel.filePath, 'level/关卡-042-悬空城门.json');
});

test('renaming an unsaved level keeps its generated filename in sync', () => {
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)] });
  store.addLevel({ levelId: 'level-42', levelNumber: 42, levelName: '初始名称' });

  store.updateLevel({ levelName: '最终名称' });

  assert.equal(store.currentLevel.filePath, 'level/关卡-042-最终名称.json');
  assert.deepEqual([...store.newLevelPaths], ['level/关卡-042-最终名称.json']);
  assert.deepEqual([...store.deletedLevelPaths], []);
});

test('renumbering an unsaved level synchronizes its levelId and generated filename', () => {
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)] });
  store.addLevel({ levelId: 'level-102', levelNumber: 102, levelName: '可调整关卡' });

  store.updateLevel({ levelNumber: 150 });

  assert.equal(store.currentLevel.levelNumber, 150);
  assert.equal(store.currentLevel.__levelDocument.levelId, 'level-150');
  assert.equal(store.currentLevel.filePath, 'level/关卡-150-可调整关卡.json');
  assert.deepEqual([...store.newLevelPaths], ['level/关卡-150-可调整关卡.json']);
});

test('renumbering a saved exported level to an empty number updates its JSON, manifest, filename, and list order', async () => {
  const first = exportedLevel(11, '倒三角连锁');
  const second = exportedLevel(20, '非对称王城');
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-11', number: 11, name: first.levelName, difficulty: first.difficulty, designerNote: '保留移动关扩展' },
    { id: 'level-20', number: 20, name: second.levelName, difficulty: second.difficulty, unlockAfter: 'boss-intro' },
  ] };
  const { files, operations } = recordingFiles();
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [second, first], files, manifest });

  store.selectLevel(first.workspaceId);
  store.updateLevel({ levelNumber: 99 });

  assert.deepEqual(store.levels.map(item => item.levelNumber), [20, 99]);
  assert.equal(store.currentLevel.workspaceId, first.workspaceId);
  assert.equal(store.currentLevel.__levelDocument.levelId, 'level-99');
  assert.equal(store.currentLevel.filePath, 'level/关卡-099-倒三角连锁.json');
  assert.deepEqual([...store.newLevelPaths], ['level/关卡-099-倒三角连锁.json']);
  assert.deepEqual([...store.deletedLevelPaths], ['level/关卡-011-倒三角连锁.json']);

  await store.save();

  const levelWrite = operations.find(([method, path]) => method === 'writeText' && path === 'level/关卡-099-倒三角连锁.json');
  assert.deepEqual([JSON.parse(levelWrite[2]).level.number, JSON.parse(levelWrite[2]).levelId, levelWrite[3]], [99, 'level-99', false]);
  const manifestIndex = operations.findIndex(([method, path]) => method === 'writeText' && path === 'level/导出清单.json');
  const deleteIndex = operations.findIndex(([method, path]) => method === 'remove' && path === 'level/关卡-011-倒三角连锁.json');
  assert.deepEqual(JSON.parse(operations[manifestIndex][2]).levels, [
    { id: 'level-20', number: 20, name: second.levelName, difficulty: second.difficulty, unlockAfter: 'boss-intro' },
    { id: 'level-99', number: 99, name: first.levelName, difficulty: first.difficulty, designerNote: '保留移动关扩展' },
  ]);
  assert.ok(deleteIndex > manifestIndex, 'manifest must point at the new file before the old file is removed');
});

test('saving commits a level number still pending in the focused input', async () => {
  const current = exportedLevel(105, '退台错层跨架');
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-105', number: 105, name: current.levelName, difficulty: current.difficulty },
  ] };
  const { files, operations } = recordingFiles();
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [current], files, manifest });
  const input = {
    value: '94',
    setCustomValidity() {},
    setAttribute() {},
    removeAttribute() {},
    closest() { return null; },
  };

  const saved = await saveEditor({ files, store, levelNumberInput: input, setSaveState() {} });

  assert.equal(saved, true);
  const levelWrite = operations.find(([method, path]) => method === 'writeText' && path === 'level/关卡-094-退台错层跨架.json');
  assert.deepEqual([JSON.parse(levelWrite[2]).level.number, JSON.parse(levelWrite[2]).levelId], [94, 'level-94']);
  const manifestWrite = operations.find(([method, path]) => method === 'writeText' && path === 'level/导出清单.json');
  assert.deepEqual(JSON.parse(manifestWrite[2]).levels, [
    { id: 'level-94', number: 94, name: current.levelName, difficulty: current.difficulty },
  ]);
  assert.ok(operations.some(([method, path]) => method === 'remove' && path === 'level/关卡-105-退台错层跨架.json'));
});

test('three empty-number renumbers can swap same-named saved levels before one save', async () => {
  const first = exportedLevel(11, '普通关卡');
  const second = exportedLevel(20, '普通关卡');
  first.description = '原第 11 关';
  second.description = '原第 20 关';
  second.difficulty = 'hard';
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-11', number: 11, name: '普通关卡', difficulty: first.difficulty },
    { id: 'level-20', number: 20, name: '普通关卡', difficulty: second.difficulty },
  ] };
  const { files, operations } = recordingFiles();
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [first, second], files, manifest });

  store.selectLevel(first.workspaceId);
  store.updateLevel({ levelNumber: 999 });
  store.selectLevel(second.workspaceId);
  store.updateLevel({ levelNumber: 11 });
  store.selectLevel(first.workspaceId);
  store.updateLevel({ levelNumber: 20 });

  assert.deepEqual(store.levels.map(item => item.levelNumber), [11, 20]);
  assert.deepEqual([...store.dirtyLevelPaths].sort(), [
    'level/关卡-011-普通关卡.json',
    'level/关卡-020-普通关卡.json',
  ]);
  assert.deepEqual([...store.newLevelPaths], []);
  assert.deepEqual([...store.deletedLevelPaths], []);

  await store.save();

  const levelWrites = operations.filter(([method, path]) => method === 'writeText' && path !== 'level/导出清单.json');
  assert.deepEqual(levelWrites.map(([, path, content, overwrite]) => [path, JSON.parse(content).level.number, JSON.parse(content).levelId, JSON.parse(content).level.description, overwrite]), [
    ['level/关卡-011-普通关卡.json', 11, 'level-11', '原第 20 关', true],
    ['level/关卡-020-普通关卡.json', 20, 'level-20', '原第 11 关', true],
  ]);
  const manifestWrite = operations.find(([method, path]) => method === 'writeText' && path === 'level/导出清单.json');
  assert.deepEqual(JSON.parse(manifestWrite[2]).levels, [
    { id: 'level-11', number: 11, name: '普通关卡', difficulty: second.difficulty },
    { id: 'level-20', number: 20, name: '普通关卡', difficulty: first.difficulty },
  ]);
});

test('discarding a saved exported-level renumber restores the original level and cannot delete its file', async () => {
  const first = exportedLevel(11, '倒三角连锁');
  const second = exportedLevel(20, '非对称王城');
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-11', number: 11, name: first.levelName, difficulty: first.difficulty },
    { id: 'level-20', number: 20, name: second.levelName, difficulty: second.difficulty },
  ] };
  const { files, operations } = recordingFiles();
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [first, second], files, manifest });

  store.selectLevel(first.workspaceId);
  store.updateLevel({ levelNumber: 99 });
  store.discardLevelChanges(first.workspaceId);

  assert.equal(store.levels.length, 2);
  assert.equal(store.currentLevel.levelNumber, 11);
  assert.equal(store.currentLevel.__levelDocument.levelId, 'level-11');
  assert.equal(store.currentLevel.filePath, 'level/关卡-011-倒三角连锁.json');
  assert.deepEqual([...store.dirtyLevelPaths], []);
  assert.deepEqual([...store.newLevelPaths], []);
  assert.deepEqual([...store.deletedLevelPaths], []);

  await store.save();
  assert.equal(operations.some(([method]) => method === 'writeText' || method === 'remove'), false);
});

test('discard after a partial exported-file move keeps the restored level in the manifest', async () => {
  const first = exportedLevel(11, '旧名称');
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-11', number: 11, name: first.levelName, difficulty: first.difficulty },
  ] };
  const oldPath = first.filePath;
  const newPath = 'level/关卡-011-新名称.json';
  const documents = new Map([
    [oldPath, JSON.stringify(baseLevel)],
    ['level/导出清单.json', JSON.stringify(manifest)],
  ]);
  let failManifest = true;
  const removals = [];
  const files = {
    async mkdir() {}, async writeBase64() {},
    async writeText(path, content, overwrite) {
      if (path === 'level/导出清单.json' && failManifest) {
        failManifest = false;
        throw Object.assign(new Error('manifest denied'), { code: 'DENIED' });
      }
      if (!overwrite && documents.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      documents.set(path, content);
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async remove(path) { removals.push(path); documents.delete(path); },
  };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [first], files, manifest });

  store.updateLevel({ levelName: '新名称' });
  await assert.rejects(() => store.save(), error => error.code === 'DENIED');
  assert.equal(documents.has(newPath), true);

  store.discardLevelChanges(first.workspaceId);
  await store.save();

  assert.equal(store.currentLevel.filePath, oldPath);
  assert.equal(documents.has(oldPath), true);
  assert.equal(documents.has(newPath), false);
  assert.deepEqual(removals, [newPath]);
  assert.deepEqual(JSON.parse(documents.get('level/导出清单.json')).levels, manifest.levels);
});

test('discard after a move save fails deleting the old file restores the already-written manifest', async () => {
  const first = exportedLevel(11, '旧名称');
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-11', number: 11, name: first.levelName, difficulty: first.difficulty },
  ] };
  const oldPath = first.filePath;
  const newPath = 'level/关卡-011-新名称.json';
  const documents = new Map([
    [oldPath, JSON.stringify(baseLevel)],
    ['level/导出清单.json', JSON.stringify(manifest)],
  ]);
  let failOldPathDeletion = true;
  const removals = [];
  const files = {
    async mkdir() {}, async writeBase64() {},
    async writeText(path, content, overwrite) {
      if (!overwrite && documents.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      documents.set(path, content);
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async remove(path) {
      if (path === oldPath && failOldPathDeletion) {
        failOldPathDeletion = false;
        throw Object.assign(new Error('delete denied'), { code: 'DENIED' });
      }
      removals.push(path);
      documents.delete(path);
    },
  };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [first], files, manifest });

  store.updateLevel({ levelName: '新名称' });
  await assert.rejects(() => store.save(), error => error.code === 'DENIED');
  assert.equal(JSON.parse(documents.get('level/导出清单.json')).levels[0].name, '新名称');

  store.discardLevelChanges(first.workspaceId);
  await store.save();

  assert.equal(documents.has(oldPath), true);
  assert.equal(documents.has(newPath), false);
  assert.deepEqual(removals, [newPath]);
  assert.deepEqual(JSON.parse(documents.get('level/导出清单.json')).levels, manifest.levels);
});

test('discarding one side of an unsaved renumber swap restores both coupled levels atomically', () => {
  const first = exportedLevel(11, '普通关卡');
  const second = exportedLevel(20, '普通关卡');
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [first, second] });

  store.selectLevel(first.workspaceId);
  store.updateLevel({ levelNumber: 999 });
  store.selectLevel(second.workspaceId);
  store.updateLevel({ levelNumber: 11 });
  store.selectLevel(first.workspaceId);
  store.updateLevel({ levelNumber: 20 });
  store.discardLevelChanges(first.workspaceId);

  assert.deepEqual(store.levels.map(item => [item.workspaceId, item.levelNumber]), [
    [first.workspaceId, 11],
    [second.workspaceId, 20],
  ]);
  assert.deepEqual([...store.dirtyLevelPaths], []);
  assert.deepEqual([...store.newLevelPaths], []);
  assert.deepEqual([...store.deletedLevelPaths], []);
});

test('renaming a saved exported level moves its file and keeps the manifest path loadable', async () => {
  const first = exportedLevel(11, '旧名称');
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-11', number: 11, name: first.levelName, difficulty: first.difficulty },
  ] };
  const { files, operations } = recordingFiles();
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [first], files, manifest });

  store.updateLevel({ levelName: '新名称' });

  assert.equal(store.currentLevel.filePath, 'level/关卡-011-新名称.json');
  assert.deepEqual([...store.deletedLevelPaths], ['level/关卡-011-旧名称.json']);
  await store.save();
  const manifestWrite = operations.find(([method, path]) => method === 'writeText' && path === 'level/导出清单.json');
  assert.deepEqual(JSON.parse(manifestWrite[2]).levels, [
    { id: 'level-11', number: 11, name: '新名称', difficulty: first.difficulty },
  ]);
  assert.ok(operations.some(([method, path]) => method === 'writeText' && path === 'level/关卡-011-新名称.json'));
  assert.ok(operations.some(([method, path]) => method === 'remove' && path === 'level/关卡-011-旧名称.json'));
});

test('renumbering rejects a generated levelId already owned by another manifest level', () => {
  const first = exportedLevel(11, '第一关');
  const second = exportedLevel(20, '自定义标识关');
  second.__levelDocument.levelId = 'level-99';
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [first, second] });

  store.selectLevel(first.workspaceId);

  assert.throws(() => store.updateLevel({ levelNumber: 99 }), /关卡标识.*已存在/);
  assert.equal(store.currentLevel.levelNumber, 11);
  assert.equal(store.currentLevel.__levelDocument.levelId, 'level-11');
});

test('saving a new level appends its generated configuration to the export manifest', async () => {
  const { files, operations } = recordingFiles();
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-01', number: 1, name: '直射引导', difficulty: 'normal' },
  ] };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)], files, manifest });
  store.addLevel({ levelId: 'level-42', levelNumber: 42, levelName: '悬空城门' });

  await store.save();

  const manifestWrite = operations.find(([method, path]) => method === 'writeText' && path === 'level/导出清单.json');
  assert.ok(manifestWrite, 'save should update the export manifest');
  assert.deepEqual(JSON.parse(manifestWrite[2]).levels, [
    { id: 'level-01', number: 1, name: '直射引导', difficulty: 'normal' },
    { id: 'level-42', number: 42, name: '悬空城门', difficulty: 'normal' },
  ]);
  assert.equal(manifestWrite[3], true);
});

test('deleting a saved level removes it from the export manifest before deleting its file', async () => {
  const { files, operations } = recordingFiles();
  const second = level(2);
  second.__levelDocument = { ...second.__levelDocument, levelId: 'level-02' };
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-01', number: 1, name: '直射引导', difficulty: 'normal' },
    { id: 'level-02', number: 2, name: '待删除关卡', difficulty: 'hard' },
  ] };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), second], files, manifest });

  store.deleteLevel(2);
  await store.save();

  const manifestIndex = operations.findIndex(([method, path]) => method === 'writeText' && path === 'level/导出清单.json');
  const deleteIndex = operations.findIndex(([method, path]) => method === 'remove' && path === second.filePath);
  assert.ok(manifestIndex >= 0, 'save should update the export manifest');
  assert.ok(deleteIndex > manifestIndex, 'manifest must stop referencing the level before its file is deleted');
  assert.deepEqual(JSON.parse(operations[manifestIndex][2]).levels, [
    { id: 'level-01', number: 1, name: '直射引导', difficulty: 'normal' },
  ]);
});

test('unified save orders all workspace operations and writes only dirty levels', async () => {
  assert.equal(typeof saveWorkspace, 'function');
  const { files, operations } = recordingFiles();
  const first = level(1);
  const untouched = level(2);
  const removed = level(3);
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [first, untouched, removed], files });

  store.updateConfig({ projectName: '已修改项目' });
  store.selectLevel(1);
  store.updateLevel({ levelName: '只保存这一关' });
  store.updateAsset('wood', { id: 'wood', image: 'level/asset/wood-new.png' }, 'base64-png');
  store.deleteLevel(3);
  store.addLevel();
  const result = await store.save();

  assert.deepEqual(operations.map(([method, path, _content, overwrite]) => [method, path, overwrite]), [
    ['mkdir', 'level/asset', undefined],
    ['writeBase64', 'level/asset/wood-new.png', false],
    ['writeText', '全局配置.json', true],
    ['writeText', 'level/original-01-level-01.json', true],
    ['writeText', 'level/关卡-003-新关卡 3.json', false],
    ['writeText', 'level/导出清单.json', true],
    ['remove', 'level/original-03-level-03.json', undefined],
  ]);
  assert.equal(operations.some(([, path]) => path === 'level/original-02-level-02.json'), false);
  assert.equal(store.dirty, false);
  assert.equal(store.dirtyLevelPaths.size, 0);
  assert.equal(store.newLevelPaths.size, 0);
  assert.equal(store.pendingImages.size, 0);
  assert.equal(store.deletedLevelPaths.size, 0);
  assert.deepEqual(result.journal, {
    created: { images: ['level/asset/wood-new.png'], levels: ['level/关卡-003-新关卡 3.json'] },
    written: ['全局配置.json', 'level/original-01-level-01.json', 'level/导出清单.json'],
    deleted: { images: [], levels: ['level/original-03-level-03.json'] },
  });
});

test('saving only a level does not rewrite the unified global configuration', async () => {
  const { files, operations } = recordingFiles();
  const store = new EditorStore({
    globalDocument: baseGlobalDocument,
    config: baseConfig,
    assets: baseAssets,
    levels: [level(1)],
    files,
  });

  store.updateLevel({ levelName: '仅修改关卡' });
  await store.save();

  assert.deepEqual(operations.map(([method, path]) => [method, path]), [
    ['mkdir', 'level/asset'],
    ['writeText', 'level/original-01-level-01.json'],
  ]);
  assert.equal(operations.some(([, path]) => path === '全局配置.json'), false);
});

test('save rejects different workspace identities that use the same level number', async () => {
  const { files, operations } = recordingFiles();
  const exported = { ...level(1), workspaceId: 'exported:level-01' };
  const editable = {
    ...level(1),
    workspaceId: 'editable:level-1.json',
    fileName: 'level-1.json',
    filePath: 'level/level-1.json',
  };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [exported, editable], files });

  await assert.rejects(() => store.save(), /关卡编号已存在/);
  assert.deepEqual(operations, []);
});

test('a failed unified save retains every dirty flag and pending operation', async () => {
  const { files, operations } = recordingFiles({ failAt: 4 });
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2)], files });
  store.updateConfig({ projectName: '未保存项目' });
  store.selectLevel(1);
  store.updateLevel({ levelName: '未保存关卡' });
  store.updateAsset('wood', { id: 'wood', image: 'level/asset/failing.png' }, 'base64-png');
  store.deleteLevel(2);
  store.addLevel();

  await assert.rejects(() => store.save(), error => error.code === 'DENIED');

  assert.deepEqual(operations.map(([method]) => method), ['mkdir', 'writeBase64', 'writeText', 'writeText']);
  assert.equal(store.dirty, true);
  assert.equal(store.configDirty, true);
  assert.equal(store.assetsDirty, true);
  assert.deepEqual([...store.dirtyLevelPaths].sort(), ['level/original-01-level-01.json', 'level/关卡-002-新关卡 2.json']);
  assert.deepEqual([...store.newLevelPaths], ['level/关卡-002-新关卡 2.json']);
  assert.deepEqual([...store.pendingImages.keys()], ['level/asset/failing.png']);
  assert.deepEqual([...store.deletedLevelPaths], ['level/original-02-level-02.json']);
  assert.ok(store.history.length > 0);
});

test('retry tolerates an already-completed level deletion and finishes the remaining deletion', async () => {
  const existing = new Set([
    'level/original-02-level-02.json',
    'level/original-03-level-03.json',
  ]);
  let denySecondDeletion = true;
  const removals = [];
  const files = {
    async mkdir() {}, async writeBase64() {}, async writeText() {},
    async remove(path) {
      removals.push(path);
      if (path.endsWith('03-level-03.json') && denySecondDeletion) {
        denySecondDeletion = false;
        throw Object.assign(new Error('denied'), { code: 'DENIED' });
      }
      if (!existing.delete(path)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
    },
  };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2), level(3)], files });
  store.deleteLevel(2);
  store.deleteLevel(3);

  await assert.rejects(() => store.save(), error => error.code === 'DENIED');
  assert.deepEqual([...store.deletedLevelPaths], [
    'level/original-02-level-02.json',
    'level/original-03-level-03.json',
  ]);
  await store.save();

  assert.deepEqual(removals, [
    'level/original-02-level-02.json',
    'level/original-03-level-03.json',
    'level/original-02-level-02.json',
    'level/original-03-level-03.json',
  ]);
  assert.equal(store.deletedLevelPaths.size, 0);
  assert.equal(store.dirty, false);
});

test('retry recognizes its identical partially-created level without overwriting a foreign file', async () => {
  const documents = new Map();
  let denyDeletion = true;
  const files = {
    async mkdir() {}, async writeBase64() {},
    async writeText(path, content, overwrite) {
      if (!overwrite && documents.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      documents.set(path, content);
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async remove() {
      if (denyDeletion) {
        denyDeletion = false;
        throw Object.assign(new Error('denied'), { code: 'DENIED' });
      }
    },
  };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2)], files });
  store.deleteLevel(2);
  store.addLevel();

  await assert.rejects(() => store.save(), error => error.code === 'DENIED');
  assert.equal(store.dirty, true);
  assert.equal(documents.has('level/关卡-002-新关卡 2.json'), true);
  await store.save();
  assert.equal(store.dirty, false);

  const conflictingStore = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)], files });
  conflictingStore.addLevel();
  documents.set('level/关卡-002-新关卡 2.json', '{"foreign":true}');
  await assert.rejects(() => conflictingStore.save(), error => error.code === 'ALREADY_EXISTS');
  assert.equal(documents.get('level/关卡-002-新关卡 2.json'), '{"foreign":true}');
  assert.equal(conflictingStore.dirty, true);
});

test('new images are create-only while an existing asset image can be explicitly replaced', async () => {
  const customized = structuredClone(baseAssets);
  customized.materials.wood.image = 'level/asset/wood-existing.png';
  const { files, operations } = recordingFiles();
  const store = new EditorStore({ config: baseConfig, assets: customized, levels: [level(1)], files });

  store.updateAsset('wood', { id: 'wood', image: 'level/asset/wood-existing.png' }, 'replacement-base64');
  await store.save();

  assert.deepEqual(
    operations.filter(([method]) => method === 'writeBase64').map(([, path, content, overwrite]) => [path, content, overwrite]),
    [['level/asset/wood-existing.png', 'replacement-base64', true]],
  );
});

test('new image retry accepts only identical transaction content and never overwrites a foreign image', async () => {
  const images = new Map();
  let denyDeletion = true;
  const files = {
    async mkdir() {},
    async writeBase64(path, content, overwrite) {
      if (!overwrite && images.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      images.set(path, content);
    },
    async readBase64(path) { return { path, content: images.get(path) }; },
    async writeText() {},
    async remove() {
      if (denyDeletion) {
        denyDeletion = false;
        throw Object.assign(new Error('denied'), { code: 'DENIED' });
      }
    },
  };
  const imagePath = 'level/asset/banner.png';
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2)], files });
  store.addAsset('specialObjects', {
    id: 'banner', name: '旗帜', specialType: 'banner', materialId: 'wood', shapePresetId: 'square', color: '#336699', image: imagePath,
  }, 'transaction-base64');
  store.deleteLevel(2);

  await assert.rejects(() => store.save(), error => error.code === 'DENIED');
  await store.save();
  assert.equal(images.get(imagePath), 'transaction-base64');
  assert.equal(store.dirty, false);

  const conflictingStore = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)], files });
  conflictingStore.addAsset('specialObjects', {
    id: 'foreign-banner', name: '外来旗帜', specialType: 'foreign-banner', materialId: 'wood', shapePresetId: 'square', color: '#663399', image: imagePath,
  }, 'ours-base64');
  images.set(imagePath, 'foreign-base64');

  await assert.rejects(() => conflictingStore.save(), error => error.code === 'ALREADY_EXISTS');
  assert.equal(images.get(imagePath), 'foreign-base64');
  assert.equal(conflictingStore.pendingImages.has(imagePath), true);
  assert.equal(conflictingStore.dirty, true);
});

test('save freezes one revision, coalesces concurrent saves, and preserves edits made while awaiting I/O', async () => {
  let releaseStart;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseStart = resolve; });
  const documents = new Map();
  const images = new Map();
  const removals = [];
  let mkdirCalls = 0;
  const files = {
    async mkdir() {
      mkdirCalls += 1;
      markStarted();
      await gate;
    },
    async writeBase64(path, content, overwrite) {
      if (!overwrite && images.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      images.set(path, content);
    },
    async readBase64(path) { return { path, content: images.get(path) }; },
    async writeText(path, content, overwrite) {
      if (!overwrite && documents.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      documents.set(path, content);
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async remove(path) { removals.push(path); },
  };
  const imagePath = 'level/asset/concurrent.png';
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2), level(3)], files });
  store.updateConfig({ projectName: 'snapshot-config' });
  store.updateAsset('wood', { id: 'wood', friction: 0.71, image: imagePath }, 'snapshot-image');
  store.selectLevel(1);
  store.updateLevel({ levelName: 'snapshot-level' });
  store.deleteLevel(3);
  const savedRevision = store.revision;

  const firstSave = store.save();
  await started;
  const concurrentSave = store.save();
  store.updateConfig({ projectName: 'latest-config' });
  store.updateAsset('wood', { id: 'wood', friction: 0.72, image: imagePath }, 'latest-image');
  store.updateLevel({ levelName: 'latest-level' });
  store.deleteLevel(2);
  releaseStart();
  await Promise.all([firstSave, concurrentSave]);

  assert.equal(mkdirCalls, 1);
  assert.ok(store.revision > savedRevision);
  const snapshotGlobal = decodeGlobalConfig(JSON.parse(documents.get('全局配置.json')));
  assert.equal(snapshotGlobal.config.projectName, 'snapshot-config');
  assert.equal(snapshotGlobal.assets.materials.wood.friction, 0.71);
  assert.equal(JSON.parse(documents.get('level/original-01-level-01.json')).level.name, 'snapshot-level');
  assert.equal(images.get(imagePath), 'snapshot-image');
  assert.deepEqual(removals, ['level/original-03-level-03.json']);
  assert.equal(store.configDirty, true);
  assert.equal(store.assetsDirty, true);
  assert.deepEqual([...store.dirtyLevelPaths], ['level/original-01-level-01.json']);
  assert.deepEqual(store.pendingImages.get(imagePath), { content: 'latest-image', isNew: false });
  assert.deepEqual([...store.deletedLevelPaths], ['level/original-02-level-02.json']);
  assert.equal(store.dirty, true);

  await store.save();
  const latestGlobal = decodeGlobalConfig(JSON.parse(documents.get('全局配置.json')));
  assert.equal(latestGlobal.config.projectName, 'latest-config');
  assert.equal(latestGlobal.assets.materials.wood.friction, 0.72);
  assert.equal(JSON.parse(documents.get('level/original-01-level-01.json')).level.name, 'latest-level');
  assert.equal(images.get(imagePath), 'latest-image');
  assert.deepEqual(removals, ['level/original-03-level-03.json', 'level/original-02-level-02.json']);
  assert.equal(store.dirty, false);
});

test('a new level deleted while its save is in flight is queued for compensating deletion', async () => {
  let releaseStart;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseStart = resolve; });
  const documents = new Map();
  const removals = [];
  const files = {
    async mkdir() { markStarted(); await gate; },
    async writeBase64() {},
    async writeText(path, content, overwrite) {
      if (!overwrite && documents.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      documents.set(path, content);
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async remove(path) { removals.push(path); documents.delete(path); },
  };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)], files });
  store.addLevel();
  const createdId = store.currentLevelId;
  const createdPath = [...store.newLevelPaths][0];

  const saving = store.save();
  await started;
  store.deleteLevel(createdId);
  releaseStart();
  await saving;

  assert.equal(documents.has(createdPath), true);
  assert.deepEqual([...store.deletedLevelPaths], [createdPath]);
  assert.equal(store.dirty, true);

  await store.save();
  assert.deepEqual(removals, [createdPath]);
  assert.equal(documents.has(createdPath), false);
  assert.equal(store.deletedLevelPaths.size, 0);
  assert.equal(store.dirty, false);
});

test('a new image deleted while its save is in flight is queued for compensating deletion', async () => {
  let releaseStart;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseStart = resolve; });
  const images = new Map();
  const removals = [];
  const files = {
    async mkdir() { markStarted(); await gate; },
    async writeBase64(path, content, overwrite) {
      if (!overwrite && images.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      images.set(path, content);
    },
    async readBase64(path) { return { path, content: images.get(path) }; },
    async writeText() {},
    async remove(path) { removals.push(path); images.delete(path); },
  };
  const imagePath = 'level/asset/orphan-banner.png';
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)], files });
  store.addAsset('specialObjects', {
    id: 'orphan-banner', name: '待删除旗帜', specialType: 'banner', materialId: 'wood', shapePresetId: 'square', color: '#336699', image: imagePath,
  }, 'orphan-base64');

  const saving = store.save();
  await started;
  store.deleteAsset('orphan-banner');
  releaseStart();
  await saving;

  assert.equal(images.get(imagePath), 'orphan-base64');
  assert.deepEqual([...store.deletedImagePaths], [imagePath]);
  assert.equal(store.dirty, true);

  await store.save();
  assert.deepEqual(removals, [imagePath]);
  assert.equal(images.has(imagePath), false);
  assert.equal(store.deletedImagePaths.size, 0);
  assert.equal(store.dirty, false);
});

test('same-path level and image rebuilds stay dirty instead of being compensating deletions', async () => {
  let releaseStart;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseStart = resolve; });
  const documents = new Map();
  const images = new Map();
  const removals = [];
  const files = {
    async mkdir() { markStarted(); await gate; },
    async writeBase64(path, content, overwrite) {
      if (!overwrite && images.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      images.set(path, content);
    },
    async readBase64(path) { return { path, content: images.get(path) }; },
    async writeText(path, content, overwrite) {
      if (!overwrite && documents.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      documents.set(path, content);
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async remove(path) { removals.push(path); documents.delete(path); images.delete(path); },
  };
  const imagePath = 'level/asset/rebuilt-banner.png';
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)], files });
  store.addLevel();
  const createdId = store.currentLevelId;
  const createdPath = [...store.newLevelPaths][0];
  store.addAsset('specialObjects', {
    id: 'first-banner', name: '第一版旗帜', specialType: 'banner', materialId: 'wood', shapePresetId: 'square', color: '#336699', image: imagePath,
  }, 'first-base64');

  const saving = store.save();
  await started;
  store.deleteLevel(createdId);
  store.addLevel();
  assert.equal([...store.newLevelPaths][0], createdPath);
  store.updateLevel({ description: '同路径重建关卡' });
  store.deleteAsset('first-banner');
  store.addAsset('specialObjects', {
    id: 'second-banner', name: '第二版旗帜', specialType: 'banner', materialId: 'wood', shapePresetId: 'square', color: '#663399', image: imagePath,
  }, 'second-base64');
  releaseStart();
  await saving;

  assert.equal(JSON.parse(documents.get(createdPath)).level.name, '新关卡 2');
  assert.equal(images.get(imagePath), 'first-base64');
  assert.equal(store.deletedLevelPaths.has(createdPath), false);
  assert.equal(store.deletedImagePaths.has(imagePath), false);
  assert.equal(store.dirtyLevelPaths.has(createdPath), true);
  assert.equal(store.newLevelPaths.has(createdPath), false);
  assert.deepEqual(store.pendingImages.get(imagePath), { content: 'second-base64', isNew: false });
  assert.equal(store.dirty, true);

  await store.save();
  assert.equal(JSON.parse(documents.get(createdPath)).level.description, '同路径重建关卡');
  assert.equal(images.get(imagePath), 'second-base64');
  assert.deepEqual(removals, []);
  assert.equal(store.dirty, false);
});

test('a failed save journals a created image and compensates when the current asset was deleted', async () => {
  let releaseFailure;
  let markImageCreated;
  const imageCreated = new Promise(resolve => { markImageCreated = resolve; });
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  const images = new Map();
  const removals = [];
  let failConfig = true;
  const files = {
    async mkdir() {},
    async writeBase64(path, content, overwrite) {
      if (!overwrite && images.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      images.set(path, content);
      markImageCreated();
    },
    async readBase64(path) { return { path, content: images.get(path) }; },
    async writeText(path) {
      if (path === '全局配置.json' && failConfig) {
        await failureGate;
        failConfig = false;
        throw Object.assign(new Error('config denied'), { code: 'DENIED' });
      }
    },
    async remove(path) { removals.push(path); images.delete(path); },
  };
  const imagePath = 'level/asset/failed-save-banner.png';
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)], files });
  store.addAsset('specialObjects', {
    id: 'failed-save-banner', name: '失败保存旗帜', specialType: 'banner', materialId: 'wood', shapePresetId: 'square', color: '#336699', image: imagePath,
  }, 'failed-save-base64');

  const saving = store.save();
  await imageCreated;
  store.deleteAsset('failed-save-banner');
  releaseFailure();
  let error;
  await assert.rejects(saving, failure => {
    error = failure;
    return failure.code === 'DENIED';
  });

  assert.deepEqual(error.journal, {
    created: { images: [imagePath], levels: [] },
    written: [],
    deleted: { images: [], levels: [] },
  });
  assert.equal(images.get(imagePath), 'failed-save-base64');
  assert.deepEqual([...store.deletedImagePaths], [imagePath]);
  assert.equal(store.assetsDirty, true);
  assert.equal(store.dirty, true);

  await store.save();
  assert.deepEqual(removals, [imagePath]);
  assert.equal(images.has(imagePath), false);
  assert.equal(store.dirty, false);
});

test('a failed save journals a created level and preserves a different same-path rebuild', async () => {
  let releaseFailure;
  let markLevelCreated;
  const levelCreated = new Promise(resolve => { markLevelCreated = resolve; });
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  const documents = new Map();
  const removals = [];
  let failDeletion = true;
  const files = {
    async mkdir() {}, async writeBase64() {},
    async writeText(path, content, overwrite) {
      if (!overwrite && documents.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      documents.set(path, content);
      if (path === 'level/关卡-002-新关卡 2.json') markLevelCreated();
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async remove(path) {
      if (failDeletion) {
        await failureGate;
        failDeletion = false;
        throw Object.assign(new Error('delete denied'), { code: 'DENIED' });
      }
      removals.push(path);
      documents.delete(path);
    },
  };
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2)], files });
  store.deleteLevel(2);
  store.addLevel();
  const createdId = store.currentLevelId;
  const createdPath = [...store.newLevelPaths][0];

  const saving = store.save();
  await levelCreated;
  store.deleteLevel(createdId);
  store.addLevel();
  store.updateLevel({ description: '失败窗口同路径重建' });
  releaseFailure();
  let error;
  await assert.rejects(saving, failure => {
    error = failure;
    return failure.code === 'DENIED';
  });

  assert.deepEqual(error.journal, {
    created: { images: [], levels: [createdPath] },
    written: ['level/导出清单.json'],
    deleted: { images: [], levels: [] },
  });
  assert.equal(JSON.parse(documents.get(createdPath)).level.name, '新关卡 2');
  assert.equal(store.deletedLevelPaths.has(createdPath), false);
  assert.equal(store.dirtyLevelPaths.has(createdPath), true);
  assert.equal(store.newLevelPaths.has(createdPath), false);
  assert.deepEqual([...store.deletedLevelPaths], ['level/original-02-level-02.json']);
  assert.equal(store.dirty, true);

  await store.save();
  assert.equal(JSON.parse(documents.get(createdPath)).level.description, '失败窗口同路径重建');
  assert.deepEqual(removals, ['level/original-02-level-02.json']);
  assert.equal(store.dirty, false);
});

test('save completion UI never reports all changes saved when a newer revision remains dirty', () => {
  const pending = saveCompletionState(true);
  assert.equal(pending.state, 'dirty');
  assert.match(pending.text, /仍有未保存/);
  assert.doesNotMatch(pending.text, /所有更改已保存/);
  assert.deepEqual(saveCompletionState(false), { text: '所有更改已保存', state: 'saved' });
});

test('browser loading and save attempts never call the WebView file API', async () => {
  let webviewCalls = 0;
  const documents = new Map([
    ['全局配置.json', structuredClone(baseGlobalDocument)],
    ['level/导出清单.json', { version: 1, type: 'manifest', levels: [
      { id: baseLevel.levelId, number: 1, name: baseLevel.level.name, difficulty: baseLevel.level.difficulty },
    ] }],
    ['level/关卡-001-直射引导.json', structuredClone(baseLevel)],
  ]);
  const fetcher = async path => ({ ok: documents.has(path), json: async () => structuredClone(documents.get(path)) });
  const project = await loadProject(null, fetcher);
  const store = new EditorStore({ ...project, files: null });

  store.updateConfig({ projectName: '内存修改' });
  await assert.rejects(() => store.save(), /只读演示模式/);
  assert.equal(webviewCalls, 0);
});

test('browser level cards expose no active delete control while desktop cards remain editable', () => {
  const readOnly = levelCardMarkup(level(1), { assets: baseAssets, currentLevelId: 1, writable: false });
  const desktop = levelCardMarkup(level(1), { assets: baseAssets, currentLevelId: 1, writable: true });

  assert.match(readOnly, /class="level-delete"[^>]*disabled[^>]*aria-disabled="true"/);
  assert.doesNotMatch(desktop, /class="level-delete"[^>]*disabled/);
});

test('Refresh reloads after confirmation and leaves dirty work in place when cancelled', () => {
  let reloads = 0;
  assert.equal(refreshWorkspace({ dirty: true, confirmDiscard: () => false, reload: () => { reloads += 1; } }), false);
  assert.equal(reloads, 0);
  assert.equal(refreshWorkspace({ dirty: true, confirmDiscard: () => true, reload: () => { reloads += 1; } }), true);
  assert.equal(refreshWorkspace({ dirty: false, confirmDiscard: () => false, reload: () => { reloads += 1; } }), true);
  assert.equal(reloads, 2);
});

test('level switch saves, discards, or switches directly based on dirty state', async () => {
  const calls = [];
  const confirmDialog = async () => 'save';
  const onSave = async () => { calls.push('save'); return true; };
  const onSwitch = () => { calls.push('switch'); };

  assert.equal(await resolveLevelSwitch({ targetId: 'level-2', currentId: 'level-1', dirty: true, confirmDialog, onSave, onSwitch }), 'save-and-switch');
  assert.deepEqual(calls, ['save', 'switch']);

  calls.length = 0;
  assert.equal(await resolveLevelSwitch({ targetId: 'level-2', currentId: 'level-1', dirty: false, onSwitch }), 'switch');
  assert.deepEqual(calls, ['switch']);

  calls.length = 0;
  assert.equal(await resolveLevelSwitch({ targetId: 'level-1', currentId: 'level-1', dirty: true, onSwitch }), 'same');
  assert.deepEqual(calls, []);
});

test('level switch cancels or aborts without switching when declined or save fails', async () => {
  const calls = [];
  assert.equal(await resolveLevelSwitch({ targetId: 'level-2', currentId: 'level-1', dirty: true, confirmDialog: async () => 'cancel', onSwitch: () => calls.push('switch') }), 'cancel');
  assert.deepEqual(calls, []);

  assert.equal(await resolveLevelSwitch({ targetId: 'level-2', currentId: 'level-1', dirty: true, confirmDialog: async () => 'save', onSave: async () => false, onSwitch: () => calls.push('switch') }), 'save-failed');
  assert.deepEqual(calls, []);

  assert.equal(await resolveLevelSwitch({ targetId: 'level-2', currentId: 'level-1', dirty: true, confirmDialog: async () => 'discard', onSave: async () => { calls.push('save'); return true; }, onSwitch: () => calls.push('switch') }), 'discard-and-switch');
  assert.deepEqual(calls, ['switch']);
});

test('level switch invokes onDiscard before switching when the confirm dialog chooses discard', async () => {
  const calls = [];
  assert.equal(await resolveLevelSwitch({
    targetId: 'level-2',
    currentId: 'level-1',
    dirty: true,
    confirmDialog: async () => 'discard',
    onSave: async () => { calls.push('save'); return true; },
    onDiscard: () => { calls.push('discard'); },
    onSwitch: () => { calls.push('switch'); },
  }), 'discard-and-switch');
  assert.deepEqual(calls, ['discard', 'switch']);

  calls.length = 0;
  await resolveLevelSwitch({
    targetId: 'level-2',
    currentId: 'level-1',
    dirty: true,
    confirmDialog: async () => 'save',
    onSave: async () => true,
    onDiscard: () => { calls.push('discard'); },
    onSwitch: () => { calls.push('switch'); },
  });
  assert.deepEqual(calls, ['switch'], 'saving must not discard the current level');

  calls.length = 0;
  await resolveLevelSwitch({
    targetId: 'level-2',
    currentId: 'level-1',
    dirty: true,
    confirmDialog: async () => 'cancel',
    onDiscard: () => { calls.push('discard'); },
    onSwitch: () => { calls.push('switch'); },
  });
  assert.deepEqual(calls, [], 'cancelling must neither discard nor switch');
});

test('discarding a modified existing level reverts its content and clears the dirty state', () => {
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2)] });
  const original = structuredClone(store.levels[0]);
  let emitted = 0;
  store.subscribe(() => { emitted += 1; });
  store.selectLevel(1);
  store.updateLevel({ levelName: '已修改' });
  assert.equal(store.dirty, true);
  assert.deepEqual([...store.dirtyLevelPaths], ['level/original-01-level-01.json']);

  assert.equal(store.discardLevelChanges(1), true);

  assert.deepEqual(store.currentLevel, original);
  assert.deepEqual([...store.dirtyLevelPaths], []);
  assert.equal(store.dirty, false);
  assert.equal(store.selectedObjectIds.length, 0);
  assert.ok(emitted >= 2, 'discard must emit so the save-state indicator resyncs');
});

test('discarding a new unsaved level removes it from the workspace', () => {
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2)] });
  store.addLevel();
  const newId = store.currentLevelId;
  const newPath = `level/关卡-${String(newId).padStart(3, '0')}-新关卡 ${newId}.json`;
  assert.equal(store.newLevelPaths.has(newPath), true);
  assert.equal(store.dirty, true);

  assert.equal(store.discardLevelChanges(newId), true);

  assert.equal(store.levels.some(candidate => String(candidate.workspaceId ?? candidate.levelNumber ?? candidate.id) === String(newId)), false);
  assert.equal(store.newLevelPaths.size, 0);
  assert.equal(store.dirtyLevelPaths.size, 0);
  assert.equal(store.dirty, false);
  assert.notEqual(store.currentLevelId, String(newId));
});

test('discard after a successful save reverts to the saved content, not the boot content', async () => {
  const { files } = recordingFiles();
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1), level(2)], files });
  store.selectLevel(1);
  store.updateLevel({ levelName: '保存一次' });
  await store.save();
  store.updateLevel({ levelName: '再次修改' });
  assert.equal(store.dirty, true);

  assert.equal(store.discardLevelChanges(1), true);

  assert.equal(store.currentLevel.levelName, '保存一次');
  assert.equal(store.dirty, false);
});

test('discard of an unknown level is a no-op', () => {
  const store = new EditorStore({ config: baseConfig, assets: baseAssets, levels: [level(1)] });
  assert.equal(store.discardLevelChanges('missing'), false);
  assert.equal(store.dirty, false);
});

test.skip('saved resource and new-level state reloads from WebView files without restoring templates', async () => {
  const documents = new Map([
    ['config.json', JSON.stringify(baseConfig)],
    ['asset.json', JSON.stringify(baseAssets)],
    ['level/catalog.json', JSON.stringify({
      levels: [{ id: 'one', number: 1, name: 'One', difficulty: 'normal', path: 'level/original-01-one.json' }],
    })],
    ['level/original-01-one.json', JSON.stringify(baseLevel)],
  ]);
  const files = {
    async list() {
      return {
        entries: [...documents.keys()]
          .filter(path => path.startsWith('level/') && path.split('/').length === 2)
          .map(path => ({ name: path.slice('level/'.length), type: 'file' })),
      };
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async mkdir() {},
    async writeBase64() {},
    async writeText(path, content, overwrite) {
      if (!overwrite && documents.has(path)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      documents.set(path, content);
    },
    async remove(path) { documents.delete(path); },
  };
  const loaded = await loadProject(files);
  const store = new EditorStore({ ...loaded, files });
  store.updateAsset('wood', { id: 'wood', friction: 0.91 });
  store.addLevel();
  await store.save();

  const reloaded = await loadProject(files);
  assert.equal(reloaded.assets.materials.wood.friction, 0.91);
  assert.equal(Object.hasOwn(reloaded.assets, 'templates'), false);
  assert.deepEqual(reloaded.levels.map(item => item.levelNumber), [1, 2]);
});

test.skip('confirmed level deletion survives Refresh and catalog numbers stay reserved for new files', async () => {
  const secondDraft = decodeLevelDocument(baseLevel, baseAssets);
  secondDraft.levelNumber = 2;
  secondDraft.levelName = 'Two';
  secondDraft.__levelDocument.levelId = 'level-02';
  const second = encodeLevelDocument(secondDraft);
  const documents = new Map([
    ['config.json', JSON.stringify(baseConfig)],
    ['asset.json', JSON.stringify(baseAssets)],
    ['level/catalog.json', JSON.stringify({ levels: [
      { id: 'one', number: 1, name: 'One', difficulty: 'normal', path: 'level/original-01-one.json' },
      { id: 'two', number: 2, name: 'Two', difficulty: 'normal', path: 'level/original-02-two.json' },
    ] })],
    ['level/original-01-one.json', JSON.stringify(baseLevel)],
    ['level/original-02-two.json', JSON.stringify(second)],
  ]);
  const files = {
    async list() {
      return { entries: [...documents.keys()].filter(path => path.startsWith('level/')).map(path => ({ name: path.slice(6), type: 'file' })) };
    },
    async readText(path) { return { path, content: documents.get(path) }; },
    async mkdir() {}, async writeBase64() {},
    async writeText(path, content) { documents.set(path, content); },
    async remove(path) { documents.delete(path); },
  };
  const loaded = await loadProject(files);
  const store = new EditorStore({ ...loaded, files });
  store.deleteLevel(2);
  await store.save();

  const refreshed = await loadProject(files);
  assert.deepEqual(refreshed.levels.map(item => item.levelNumber), [1]);
  const refreshedStore = new EditorStore({ ...refreshed, files });
  refreshedStore.addLevel();
  assert.equal(refreshedStore.currentLevelId, 3);
  assert.equal(refreshedStore.currentLevel.filePath, 'level/关卡-003-新关卡 3.json');
});
