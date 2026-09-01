import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { exportedLevelFilename, exportManifestLevelEntries, EXPORT_MANIFEST_FILE } from '../levellist.js';
import { loadProject } from '../static/js/editor.js';
import { EditorStore } from '../static/js/editor-store.js';

const root = new URL('../', import.meta.url);

test('export manifest resolves Chinese level filenames in manifest order', async () => {
  const manifest = JSON.parse(await readFile(new URL('level/导出清单.json', root), 'utf8'));
  const names = await readdir(new URL('level/', root));

  const entries = exportManifestLevelEntries(manifest, names);

  assert.equal(EXPORT_MANIFEST_FILE, '导出清单.json');
  assert.equal(entries.length, manifest.levels.length);
  assert.deepEqual(entries.map(entry => entry.path), manifest.levels.map(entry => `level/${exportedLevelFilename(entry)}`));
  assert.deepEqual(entries.map(entry => entry.number), manifest.levels.map(entry => entry.number));
});

test('export manifest rejects missing and mismatched level files', () => {
  const manifest = { version: 1, type: 'manifest', levels: [
    { id: 'level-01', number: 1, name: '直射引导', difficulty: 'normal' },
  ] };

  assert.throws(() => exportManifestLevelEntries(manifest, []), /缺少关卡文件/);
  assert.throws(
    () => exportManifestLevelEntries(manifest, ['关卡-001-别名.json']),
    /缺少关卡文件/,
  );
});

test('browser project loading uses 导出清单.json as the directory index', async () => {
  const manifest = JSON.parse(await readFile(new URL('level/导出清单.json', root), 'utf8'));
  const requested = [];
  const fetcher = async path => {
    requested.push(path);
    try {
      const content = await readFile(new URL(path, root), 'utf8');
      return { ok: true, json: async () => JSON.parse(content) };
    } catch {
      return { ok: false, status: 404 };
    }
  };

  const project = await loadProject(null, fetcher);

  assert.equal(project.levels.length, manifest.levels.length);
  assert.deepEqual(project.levels.map(level => level.fileName), manifest.levels.map(exportedLevelFilename));
  assert.ok(requested.includes('全局配置.json'));
  assert.ok(!requested.includes('config.json'));
  assert.ok(!requested.includes('asset.json'));
  assert.ok(requested.includes('level/导出清单.json'));
  assert.ok(!requested.includes('level/catalog.json'));
});

test('desktop loading discovers an existing editable level before allocating the next level path', async () => {
  const [globalText, firstLevelText] = await Promise.all([
    readFile(new URL('全局配置.json', root), 'utf8'),
    readFile(new URL('level/关卡-001-直射引导.json', root), 'utf8'),
  ]);
  const editable = JSON.parse(firstLevelText);
  editable.levelId = 'level-101';
  editable.level.number = 101;
  editable.level.name = '新关卡 101';
  const documents = new Map([
    ['全局配置.json', globalText],
    ['level/导出清单.json', JSON.stringify({
      version: 1,
      type: 'manifest',
      levels: [{ id: 'level-01', number: 1, name: '直射引导', difficulty: 'normal' }],
    })],
    ['level/关卡-001-直射引导.json', firstLevelText],
    ['level/level-101.json', JSON.stringify(editable)],
  ]);
  const files = {
    async list() {
      return {
        entries: [...documents.keys()]
          .filter(path => path.startsWith('level/'))
          .map(path => ({ name: path.slice('level/'.length), type: 'file' })),
      };
    },
    async readText(path) { return { path, content: documents.get(path) }; },
  };

  const project = await loadProject(files);
  const store = new EditorStore({ ...project, files });
  store.addLevel();

  assert.deepEqual(project.levels.map(level => level.levelNumber), [1, 101]);
  assert.equal(store.currentLevel.filePath, 'level/关卡-102-新关卡 102.json');
});

test('production loaders no longer depend on level/catalog.json', async () => {
  const sources = await Promise.all([
    readFile(new URL('static/js/editor.js', root), 'utf8'),
    readFile(new URL('static/js/editor-host.js', root), 'utf8'),
  ]);
  assert.doesNotMatch(sources.join('\n'), /level\/catalog\.json/);
  assert.match(sources.join('\n'), /导出清单\.json|EXPORT_MANIFEST_FILE/);
});
