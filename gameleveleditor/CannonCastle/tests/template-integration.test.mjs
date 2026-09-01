import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateLevel } from '../gamelogic.js';
import { decodeLevelDocument } from '../static/js/level-document.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import { exportManifestLevelEntries } from '../levellist.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('adapted editor keeps the latest LevelCraft shell and required entry points', async () => {
  const html = await read('index.html');
  for (const landmark of [
    'LevelCraft', 'class="workspace"', 'id="edit-toggle"',
    'data-tab="global"', 'data-tab="level"', 'data-tab="element"',
    'id="refresh-button"', 'id="save-button"',
  ]) assert.match(html, new RegExp(landmark));
  assert.match(html, /static\/js\/editor\.js/);
});

test('asset schema and resource UI contain no combination templates', async () => {
  const [globalText, html, editorText] = await Promise.all([
    read('全局配置.json'), read('index.html'), read('static/js/editor.js'),
  ]);

  const { assets } = decodeGlobalConfig(JSON.parse(globalText));
  assert.equal(Object.hasOwn(assets, 'templates'), false);
  assert.doesNotMatch(html, /value="template"|组合模板|自定义模板/);
  assert.doesNotMatch(editorText, /assets\.templates|catalogType\s*===\s*["']template["']|自定义模板/);
});

test('asset library exposes editing and placement without a resource creation entry point', async () => {
  const [html, editor] = await Promise.all([read('index.html'), read('static/js/editor.js')]);

  assert.doesNotMatch(html, /id="add-asset"|aria-label="添加资源"/);
  assert.doesNotMatch(editor, /store\.addAsset\s*\(/);
  assert.match(editor, /store\.updateAsset\s*\(/);
  assert.match(editor, /addAssetObject\s*\(/);
});

test('production play HUD exposes accessible projectile information cards and ammo status', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../static/css/editor.css', import.meta.url), 'utf8'),
  ]);

  const cards = html.match(/<button\b(?=[^>]*\bclass="[^"]*\bprojectile-card\b[^"]*")[^>]*>[\s\S]*?<\/button>/g) ?? [];
  assert.equal(cards.length, 4);
  assert.match(cards[0], /data-projectile="normal"/);
  assert.match(cards[1], /data-projectile="explosive"/);
  assert.match(cards[2], /data-projectile="split"/);
  assert.match(cards[3], /data-projectile="blackHole"/);
  for (const card of cards) {
    assert.equal((card.match(/<span\b[^>]*\bclass="[^"]*\bprojectile-icon\b[^"]*"[^>]*\baria-hidden="true"[^>]*>/g) ?? []).length, 1);
    assert.equal((card.match(/<span\b[^>]*\bclass="[^"]*\bprojectile-copy\b[^"]*"[^>]*>/g) ?? []).length, 1);
  }
  assert.match(html, /data-projectile="normal"[\s\S]*?普通炮弹[\s\S]*?data-ammo="normal"/);
  assert.match(html, /data-projectile="explosive"[\s\S]*?爆炸炮弹[\s\S]*?data-ammo="explosive"/);
  assert.match(html, /data-projectile="split"[\s\S]*?分裂炮弹[\s\S]*?data-ammo="split"/);
  assert.match(html, /data-projectile="blackHole"[\s\S]*?黑洞炮弹[\s\S]*?data-ammo="blackHole"/);

  const hudIndex = html.indexOf('data-projectile="normal"');
  const stack = [];
  for (const match of html.slice(0, hudIndex).matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
    const [tag, name, attributes] = match;
    if (tag.startsWith('</')) {
      const index = stack.map(entry => entry.name).lastIndexOf(name);
      if (index >= 0) stack.splice(index);
    } else if (!/\/$/.test(attributes) && !['meta', 'link', 'input', 'img', 'br'].includes(name)) {
      stack.push({ name, classes: /class="([^"]*)"/.exec(attributes)?.[1].split(/\s+/).filter(Boolean) ?? [] });
    }
  }
  const hiddenClasses = new Set();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:display\s*:\s*none|visibility\s*:\s*hidden)/.test(rule[2])) continue;
    for (const className of rule[1].matchAll(/\.([\w-]+)/g)) hiddenClasses.add(className[1]);
  }
  assert.deepEqual(stack.flatMap(entry => entry.classes).filter(className => hiddenClasses.has(className)), []);
  assert.match(css, /\.projectile-card\[aria-pressed="true"\]/);
});

test('level inspector exposes typed controls for every level-owned setting', async () => {
  const html = await read('index.html');
  for (const id of [
    'level-description',
    'level-normal-ammo',
    'level-explosive-ammo',
    'level-split-ammo',
    'level-black-hole-ammo',
    'level-platform-type',
    'level-extensions',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="level-rules"/);
  assert.match(html, /data-panel="level"[\s\S]*?class="field-grid field-grid--three"/);
});

test('editor coordinates the free-world adapter without embedding shape gameplay rules', async () => {
  const [editor, adapter] = await Promise.all([
    read('static/js/editor.js'),
    read('static/js/free-world-editor.js'),
  ]);

  assert.match(editor, /createFreeWorldEditor/);
  assert.doesNotMatch(editor, /shape\.kind/);
  assert.match(adapter, /export function createFreeWorldEditor/);
});

test('shipped configuration and sample use a free-coordinate playable level', async () => {
  const [globalDocument, level] = await Promise.all([
    read('全局配置.json').then(JSON.parse),
    read('level/关卡-001-直射引导.json').then(JSON.parse),
  ]);
  const { config, assets } = decodeGlobalConfig(globalDocument);
  const decoded = decodeLevelDocument(level, assets);

  assert.deepEqual(config.world, { width: 9, height: 16 });
  assert.equal(config.canvas.width, 750);
  assert.equal(config.canvas.height, 1624);
  assert.ok(Array.isArray(decoded.castle) && decoded.castle.length >= 3);
  assert.ok(decoded.castle.some(({ shape }) => shape.kind === 'circle'));
  assert.ok(decoded.castle.some(({ shape }) => shape.kind === 'polygon'));
  assert.equal(Object.hasOwn(decoded, 'board'), false);
  assert.equal(Object.hasOwn(decoded, 'width'), false);
  assert.equal(Object.hasOwn(decoded, 'height'), false);
});

test('declared Node runtime includes the global WebSocket required by the browser runner', async () => {
  const packageJson = await read('package.json').then(JSON.parse);
  assert.match(packageJson.engines.node, /^>=2[2-9]/);
});

test('template copy, runtime, and exported levels remain intact', async () => {
  const [baseline, runtime, globalDocument] = await Promise.all([
    read('tests/latest-template-baseline.test.mjs'),
    read('static/vendor/meteor-original-runtime.js'),
    read('全局配置.json').then(JSON.parse),
  ]);
  const { assets } = decodeGlobalConfig(globalDocument);
  assert.ok(baseline.length > 0);
  assert.ok(runtime.length > 1000);
  const manifest = await read('level/导出清单.json').then(JSON.parse);
  const entries = exportManifestLevelEntries(manifest);
  const originals = await Promise.all(entries.map(entry => read(entry.path)));
  assert.equal(originals.length, manifest.levels.length);
  originals.forEach((content, index) => {
    const result = validateLevel(decodeLevelDocument(JSON.parse(content), assets), assets);
    assert.equal(result.ok, true, `original level ${index + 1} failed validation: ${JSON.stringify(result.errors)}`);
  });
});
