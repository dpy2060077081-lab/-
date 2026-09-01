import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadProject } from '../static/js/editor.js';
import { LocalFiles } from '../static/js/local-files.js';

const fixtureModule = await import('./browser-smoke-fixture.js').catch(() => ({}));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('shared smoke fixture uses the unified config and export manifest through LocalFiles/loadProject', async () => {
  const createFixture = fixtureModule.createSmokeWorkspaceFixture;
  const createApi = fixtureModule.createMemoryFileApi;
  assert.equal(typeof createFixture, 'function');
  assert.equal(typeof createApi, 'function');
  const [globalText, levelText] = await Promise.all([
    read('全局配置.json'), read('level/关卡-001-直射引导.json'),
  ]);
  const fixture = createFixture({ globalText, levelText });
  const manifest = JSON.parse(fixture.documents['level/导出清单.json']);

  assert.equal(manifest.levels.length, 2);
  assert.deepEqual(fixture.levelNames, ['关卡-001-烟测编辑关.json', '关卡-002-烟测下一关.json']);

  const project = await loadProject(new LocalFiles(createApi(fixture)));
  assert.deepEqual(project.levels.map(level => level.fileName), fixture.levelNames);
  assert.deepEqual(project.levels.map(level => level.levelNumber), [1, 2]);
});

test('harness and runner consume the same fixture module so catalog behavior cannot drift', async () => {
  const [harness, runner] = await Promise.all([
    read('tests/browser-smoke-harness.js'), read('tests/browser-smoke-runner.mjs'),
  ]);
  assert.match(harness, /from ['"]\.\/browser-smoke-fixture\.js['"]/);
  assert.match(runner, /from ['"]\.\/browser-smoke-fixture\.js['"]/);
});
