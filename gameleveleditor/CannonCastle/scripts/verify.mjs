import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateLevel } from '../gamelogic.js';
import { cloneLevel, serializeLevel, validateLevelShape } from '../static/js/level-config.js';
import { ORIGINAL_SOURCE_HASH } from '../static/js/original-runtime-adapter.js';
import { decodeLevelDocument, encodeLevelDocument, isExportedLevelDocument } from '../static/js/level-document.js';
import { decodeGlobalConfig } from '../static/js/global-config-document.js';
import { EDITABLE_LEVEL_FILE_PATTERN, exportManifestLevelEntries, EXPORT_MANIFEST_FILE } from '../levellist.js';

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provenancePath = resolve(root, 'scripts/template-provenance.json');
const browserRunnerPath = resolve(root, 'tests/browser-smoke-runner.mjs');
const ignoredDirectories = new Set(['.git', '.superpowers', 'node_modules']);
const nonEntryModules = new Set(['static/js/editor-host.js']);

export function resolveLevelEditorSkillRoot({ env = process.env, home = homedir() } = {}) {
  return resolve(env.LEVEL_EDITOR_SKILL_ROOT ?? resolve(home, '.codex/skills/building-game-level-editors'));
}

function display(path) {
  return relative(root, path).replaceAll('\\', '/');
}

export async function walk(directory = root, { excludedPaths = [] } = {}) {
  const excluded = new Set(excludedPaths.map(path => resolve(path)));
  async function collect(currentDirectory) {
    const files = [];
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = resolve(currentDirectory, entry.name);
      if (excluded.has(path)) continue;
      if (entry.isDirectory()) files.push(...await collect(path));
      else if (entry.isFile()) files.push(path);
    }
    return files;
  }
  return collect(resolve(directory));
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function checkTemplateProvenance() {
  const manifest = JSON.parse(await readFile(provenancePath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported template provenance schema');
  assert.equal(manifest.source?.skill, 'building-game-level-editors');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'Template provenance manifest is empty');

  const skillRoot = resolveLevelEditorSkillRoot();
  const skillPath = resolve(skillRoot, manifest.source.skillPath);
  const templateRoot = resolve(skillRoot, manifest.source.templatePath);
  assert.equal(await sha256(skillPath), manifest.source.skillSha256, 'Installed building-game-level-editors skill differs from the recorded version');

  const templateFiles = (await walk(templateRoot)).map(path => relative(templateRoot, path).replaceAll('\\', '/')).sort();
  const manifestPaths = manifest.files.map(entry => entry.path).sort();
  assert.deepEqual(templateFiles, manifestPaths, 'Current skill template file set differs from the recorded manifest');

  const treeLines = [];
  let exact = 0;
  let adapted = 0;
  for (const entry of [...manifest.files].sort((left, right) => left.path.localeCompare(right.path))) {
    assert.ok(['exact', 'adapted'].includes(entry.mode), `Unknown provenance mode for ${entry.path}`);
    const templateHash = await sha256(resolve(templateRoot, entry.path));
    const projectHash = await sha256(resolve(root, entry.projectPath ?? entry.path));
    assert.equal(templateHash, entry.templateSha256, `Current skill template drift: ${entry.path}`);
    assert.equal(projectHash, entry.projectSha256, `Undocumented project drift from recorded template adaptation: ${entry.path}`);
    treeLines.push(`${entry.path}\0${templateHash}\n`);
    if (entry.mode === 'exact') {
      exact += 1;
      assert.equal(projectHash, templateHash, `Template file must remain byte-identical: ${entry.path}`);
      assert.equal(entry.adaptation, undefined, `Exact template file must not claim an adaptation: ${entry.path}`);
    } else {
      adapted += 1;
      assert.notEqual(projectHash, templateHash, `Adapted template file unexpectedly matches the source: ${entry.path}`);
      assert.ok(typeof entry.adaptation === 'string' && entry.adaptation.trim(), `Missing adaptation rationale: ${entry.path}`);
    }
  }
  const treeHash = createHash('sha256').update(treeLines.join('')).digest('hex');
  assert.equal(treeHash, manifest.source.templateTreeSha256, 'Current skill template tree differs from the recorded version');
  return { exact, adapted, treeHash };
}

function localReferences(source) {
  const references = [];
  const patterns = [
    { pattern: /\b(?:src|href)=["']([^"']+)["']/g, base: 'source' },
    { pattern: /\b(?:from|import)\s*(?:\([^)]*)?["'](\.{1,2}\/[^"']+)["']/g, base: 'source' },
    { pattern: /\bfetchJson\(["'](\.{1,2}\/[^"']+)["']/g, base: 'document' },
  ];
  for (const { pattern, base } of patterns) {
    for (const match of source.matchAll(pattern)) references.push({ reference: match[1], base });
  }
  return references;
}

async function checkJson(files) {
  for (const path of files) JSON.parse(await readFile(path, 'utf8'));
}

async function checkJavaScript(files) {
  for (const path of files) await execFile(process.execPath, ['--check', path], { cwd: root });
}

async function importPureModules(files) {
  for (const path of files) await import(new URL(`file:///${path.replaceAll('\\', '/')}`));
}

async function checkReferencedResources(sourceFiles) {
  const checked = new Set();
  for (const sourcePath of sourceFiles) {
    const source = await readFile(sourcePath, 'utf8');
    for (const { reference, base } of localReferences(source)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(reference)) continue;
      const documentRoot = display(sourcePath) === 'static/js/editor-host.js' ? root : dirname(sourcePath);
      const target = resolve(base === 'document' ? documentRoot : dirname(sourcePath), reference.split(/[?#]/, 1)[0]);
      await access(target);
      checked.add(display(target));
    }
  }
  return checked;
}

async function validateLevels(files, assets) {
  for (const path of files) {
    const document = JSON.parse(await readFile(path, 'utf8'));
    const level = decodeLevelDocument(document, assets);
    if (isExportedLevelDocument(document)) {
      assert.deepEqual(encodeLevelDocument(level), document, `${display(path)} changed during exported v2 round trip`);
    } else {
    const shape = validateLevelShape(level);
    assert.equal(shape.valid, true, `${display(path)} failed schema validation: ${JSON.stringify(shape.errors)}`);
    }
    const gameplay = validateLevel(level, assets);
    assert.equal(gameplay.ok, true, `${display(path)} failed gameplay validation: ${JSON.stringify(gameplay.errors)}`);
  }
}

async function checkRoundTrips(files) {
  for (const path of files) {
    const level = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(JSON.parse(serializeLevel(cloneLevel(level))), level, `${display(path)} changed during legacy round trip`);
  }
}

async function checkExportManifest(levelFiles, assets) {
  const manifest = JSON.parse(await readFile(resolve(root, 'level', EXPORT_MANIFEST_FILE), 'utf8'));
  const names = levelFiles.map(path => display(path).slice('level/'.length));
  const entries = exportManifestLevelEntries(manifest, names);
  const exportedPaths = new Set(entries.map(entry => entry.path));
  const localEditablePaths = levelFiles.map(display).filter(path => !exportedPaths.has(path));
  assert.equal(
    localEditablePaths.every(path => EDITABLE_LEVEL_FILE_PATTERN.test(path.slice('level/'.length))),
    true,
    `存在未纳入导出清单且不是桌面新增关卡的文件：${localEditablePaths.join('、')}`,
  );
  for (const entry of entries) {
    const path = resolve(root, entry.path);
    const document = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(document.levelId, entry.id, `${entry.path} levelId 与导出清单不一致`);
    assert.equal(document.level?.number, entry.number, `${entry.path} 编号与导出清单不一致`);
    assert.equal(document.level?.name, entry.name, `${entry.path} 名称与导出清单不一致`);
    assert.equal(document.level?.difficulty, entry.difficulty, `${entry.path} 难度与导出清单不一致`);
    assert.equal(document.version, 2, `${entry.path} must use exported schema version 2`);
    assert.equal(document.type, 'level', `${entry.path} must be a level export`);
    const level = decodeLevelDocument(document, assets);
    const gameplay = validateLevel(level, assets);
    assert.equal(gameplay.ok, true, `${entry.path} failed gameplay validation: ${JSON.stringify(gameplay.errors)}`);
    assert.deepEqual(encodeLevelDocument(level), document, `${entry.path} changed during exported v2 round trip`);
  }
  return manifest;
}

async function checkProductionGuards(config, assets, productionBusinessFiles) {
  const [html, editor, playSession, runtimeAdapter, vendorRuntime, productionBusinessSources] = await Promise.all([
    readFile(resolve(root, 'index.html'), 'utf8'),
    readFile(resolve(root, 'static/js/editor.js'), 'utf8'),
    readFile(resolve(root, 'static/js/play-session.js'), 'utf8'),
    readFile(resolve(root, 'static/js/original-runtime-adapter.js'), 'utf8'),
    readFile(resolve(root, 'static/vendor/meteor-original-runtime.js'), 'utf8'),
    Promise.all(productionBusinessFiles.map(async path => `// ${display(path)}\n${await readFile(path, 'utf8')}`)),
  ]);
  const productionBusinessSource = productionBusinessSources.join('\n');

  assert.match(playSession, /import\s*\{\s*createOriginalRuntime\s*\}\s*from\s*['"]\.\/original-runtime-adapter\.js['"]/);
  assert.match(playSession, /:\s*createOriginalRuntime\(runtimeInput\)/, 'Production play must default to the original runtime');
  assert.match(runtimeAdapter, /from\s*['"]\.\.\/vendor\/meteor-original-runtime\.js['"]/);
  assert.match(vendorRuntime, new RegExp(`ORIGINAL_SOURCE_HASH\\s*=\\s*["']${ORIGINAL_SOURCE_HASH}["']`));
  assert.doesNotMatch(`${editor}\n${playSession}\n${runtimeAdapter}`, /\bcreateGame\b|approximate/i, 'Production module graph contains an approximate runtime path');

  assert.equal(Object.hasOwn(assets, 'templates'), false, '统一配置资产视图不得包含组合模板');
  assert.doesNotMatch(html, /value=["']template["']|组合模板|自定义模板/);
  assert.doesNotMatch(
    productionBusinessSource,
    /assets\.templates|\btemplateId\b|catalogType\s*(?::|={1,3})\s*["']template["']|组合模板|自定义模板/,
    'Production business modules contain a removed combination-template path',
  );

  assert.ok(Number.isFinite(config.canvas?.width) && config.canvas.width > 0, '全局配置.json canvas.width must be a positive number');
  assert.ok(Number.isFinite(config.canvas?.height) && config.canvas.height > 0, '全局配置.json canvas.height must be a positive number');
  assert.doesNotMatch(html, /<canvas\s+[^>]*id=["']game-canvas["'][^>]*\b(?:width|height)=/i, 'Game Canvas dimensions must not be hard-coded in HTML');
  assert.match(editor, /const size = store\.config\.canvas;/, 'Editor must source Canvas dimensions from 全局配置.json');
  assert.doesNotMatch(productionBusinessSource, /\b(?:750|1624)\b/, 'Production business modules contain hard-coded game Canvas dimensions');

  const tabs = [...html.matchAll(/class=["'][^"']*\btab\b[^"']*["'][^>]*data-tab=["']([^"']+)["']/g)].map(match => match[1]);
  assert.deepEqual(tabs, ['global', 'level', 'element'], 'Editor must retain exactly the global/level/element tabs');
  for (const landmark of ['LevelCraft', 'class="workspace"', 'id="edit-toggle"', 'id="refresh-button"', 'id="save-button"']) {
    assert.ok(html.includes(landmark), `Missing current-template shell landmark: ${landmark}`);
  }
  return { canvas: config.canvas, tabs };
}

class BrowserEnvironmentBlockedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'BrowserEnvironmentBlockedError';
  }
}

async function runBrowserSmoke() {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [browserRunnerPath], {
      cwd: root,
      maxBuffer: 10_000_000,
    });
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    console.log('Browser smoke: PASS');
  } catch (error) {
    if (error.stdout?.trim()) console.log(error.stdout.trim());
    if (error.stderr?.trim()) console.error(error.stderr.trim());
    if (Number(error.code) === 2) {
      console.error('Browser smoke: ENVIRONMENT_BLOCKED');
      throw new BrowserEnvironmentBlockedError('Full verification could not run because the browser environment blocked CDP', { cause: error });
    }
    console.error('Browser smoke: FAIL');
    throw error;
  }
}

async function main({ skipBrowser = false } = {}) {
  const files = await walk(root, { excludedPaths: [resolve(root, '.worktrees')] });
  const jsonFiles = files.filter((path) => extname(path) === '.json');
  const scriptFiles = files.filter((path) => ['.js', '.mjs'].includes(extname(path)));
  const sourceModules = scriptFiles.filter((path) => !display(path).startsWith('tests/')
    && !display(path).startsWith('scripts/')
    && !nonEntryModules.has(display(path)));
  const productionBusinessFiles = scriptFiles.filter(path => display(path) === 'gamelogic.js' || display(path).startsWith('static/js/'));
  const resourceSources = files.filter((path) => ['.html', '.js', '.mjs'].includes(extname(path)));
  const levelFiles = jsonFiles.filter((path) => display(path).startsWith('level/') && display(path) !== `level/${EXPORT_MANIFEST_FILE}`);
  const legacyFiles = [resolve(root, 'tests/fixtures/legacy-level.json')];
  const globalDocument = JSON.parse(await readFile(resolve(root, '全局配置.json'), 'utf8'));
  const { config, assets } = decodeGlobalConfig(globalDocument);
  const provenance = await checkTemplateProvenance();
  await checkJson(jsonFiles);
  await checkJavaScript(scriptFiles);
  await importPureModules(sourceModules);
  const resources = await checkReferencedResources(resourceSources);
  await validateLevels(levelFiles, assets);
  const exportManifest = await checkExportManifest(levelFiles, assets);
  const guards = await checkProductionGuards(config, assets, productionBusinessFiles);
  await checkRoundTrips(legacyFiles);

  console.log(`Template provenance: ${provenance.exact} exact, ${provenance.adapted} documented adaptations (${provenance.treeHash})`);
  console.log(`JSON files parsed: ${jsonFiles.length}`);
  console.log(`JavaScript files checked: ${scriptFiles.length}`);
  console.log(`Pure modules imported: ${sourceModules.length}`);
  console.log(`Referenced resources checked: ${resources.size}`);
  console.log(`Level files validated: ${levelFiles.length}`);
  console.log(`Manifest levels validated and round-tripped: ${exportManifest.levels.length}`);
  console.log(`Legacy round trips: ${legacyFiles.length}`);
  console.log(`Production guards: original runtime ${ORIGINAL_SOURCE_HASH}, no templates, tabs ${guards.tabs.join('/')}, Canvas ${guards.canvas.width}x${guards.canvas.height} from 全局配置.json`);
  if (skipBrowser) {
    console.log('Browser smoke: SKIPPED (--skip-browser; static diagnostics only)');
    console.log('Static diagnostics passed; full verification NOT run.');
    return;
  }
  await runBrowserSmoke();
  console.log('Verification passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argumentsSet = new Set(process.argv.slice(2));
  for (const argument of argumentsSet) {
    if (argument !== '--skip-browser') throw new Error(`Unknown verifier option: ${argument}`);
  }

  main({ skipBrowser: argumentsSet.has('--skip-browser') }).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = error instanceof BrowserEnvironmentBlockedError ? 2 : 1;
  });
}
