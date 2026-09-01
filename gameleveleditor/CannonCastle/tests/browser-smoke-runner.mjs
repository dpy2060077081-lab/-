import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Cdp,
  EnvironmentBlockedError,
  SmokeCleanupError,
  SmokeResourceTracker,
  SmokeTimeoutError,
  abortableDelay,
  runStage,
  spawnTrackedBrowser,
  terminateStartedProcessTree,
} from './browser-smoke-support.mjs';
import { createSmokeWorkspaceFixture, memoryWebViewPreloadSource } from './browser-smoke-fixture.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(root, '.superpowers/sdd/2026-08-14-latest-template-meteor-editor');
const passEvidencePath = resolve(evidence, 'task-6-browser-smoke.json');
const httpSubpath = '/meteor-editor-smoke/';
const stageTimeoutMs = 20_000;
const overallTimeoutMs = 120_000;
const resources = new SmokeResourceTracker();
let failedStage = null;
const runDiagnostics = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  stageTimeoutMs,
  overallTimeoutMs,
};
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

async function stage(label, action, timeoutMs = stageTimeoutMs, parentSignal, cleanup) {
  try {
    return await runStage(label, action, { timeoutMs, parentSignal, cleanup });
  } catch (error) {
    failedStage ??= label;
    throw error;
  }
}

async function fetchBounded(url, options = {}, timeoutMs = 10_000, parentSignal) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Fetch timed out: ${url}`)), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export async function serveWorkspace(signal) {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!pathname.startsWith(httpSubpath)) {
      response.writeHead(404).end();
      return;
    }
    const relativePath = pathname.slice(httpSubpath.length) || 'index.html';
    const target = resolve(root, relativePath);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (target !== root && !target.startsWith(prefix)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const details = await stat(target);
      if (!details.isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': contentTypes[extname(target)] ?? 'application/octet-stream' });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = runStage('smoke HTTP server shutdown', () => new Promise((resolveClose, rejectClose) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? rejectClose(error) : resolveClose());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }), { timeoutMs: 10_000, logger: { log() {}, error() {} } });
    return closePromise;
  };
  const onAbort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise((resolveListening, rejectListening) => {
      server.once('error', rejectListening);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', rejectListening);
        resolveListening();
      });
    });
    if (signal?.aborted) throw signal.reason;
  } catch (error) {
    await close();
    throw error;
  }
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}${httpSubpath}`,
    async close() {
      signal?.removeEventListener('abort', onAbort);
      await close();
    },
  };
}

export async function invalidatePassEvidence(passPath = passEvidencePath) {
  await rm(passPath, { force: true });
}

export async function ensureEvidenceDirectory(directory = evidence) {
  await mkdir(directory, { recursive: true });
}

export async function commitPassEvidence({
  passPath = passEvidencePath,
  status,
  resourcesClosed,
  summary,
  writeEvidence = writeFile,
  renameFile = rename,
} = {}) {
  await ensureEvidenceDirectory(dirname(passPath));
  await invalidatePassEvidence(passPath);
  if (status !== 'PASS' || !resourcesClosed) return false;
  const temporaryPath = `${passPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeEvidence(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    await renameFile(temporaryPath, passPath);
    return true;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    await invalidatePassEvidence(passPath).catch(() => {});
    throw error;
  }
}

async function firstAvailable(paths) {
  for (const path of paths.filter(Boolean)) {
    try { await access(path); return path; } catch {}
  }
  return null;
}

async function launchBrowser(signal) {
  const executable = await firstAvailable([
    process.env.SMOKE_BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]);
  if (!executable) throw new EnvironmentBlockedError('No supported Edge/Chrome executable found; set SMOKE_BROWSER_PATH');
  const profile = await mkdtemp(join(tmpdir(), 'meteor-editor-browser-smoke-'));
  let cleanup = async () => { throw new SmokeCleanupError('Browser cleanup was called before initialization'); };
  let devtools = null;
  const { child, browser } = spawnTrackedBrowser(spawn, [executable, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-gpu',
    '--enable-logging=stderr',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }], resources, spawned => ({
    executable,
    pid: spawned.pid,
    get devtools() { return devtools; },
    close: () => cleanup(),
  }));
  let launchError = null;
  child.once('error', error => { launchError = error; });
  const output = { stdout: '', stderr: '' };
  const capture = stream => chunk => {
    const key = stream;
    output[key] = `${output[key]}${chunk}`.slice(-16_384);
  };
  child.stdout.on('data', capture('stdout'));
  child.stderr.on('data', capture('stderr'));

  let browserCleanupPromise = null;
  cleanup = () => browserCleanupPromise ??= (async () => {
    const cleanupErrors = [];
    if (devtools) {
      try {
        const version = await (await fetchBounded(`${devtools}/json/version`, {}, 3_000)).json();
        if (version.webSocketDebuggerUrl) {
          const browserCdp = new Cdp(version.webSocketDebuggerUrl, { commandTimeoutMs: 5_000 });
          resources.trackCdp(browserCdp);
          try { await browserCdp.send('Browser.close'); }
          catch (error) { console.warn(`[smoke] Browser.close command did not acknowledge before socket shutdown: ${error.message}`); }
          try { await resources.closeCdp(browserCdp); }
          catch (error) { cleanupErrors.push(error); }
        }
      } catch (error) { console.warn(`[smoke] Browser DevTools cleanup endpoint unavailable; falling back to exact-PID termination: ${error.message}`); }
    }
    try { await terminateStartedProcessTree(child, { timeoutMs: 10_000 }); } catch (error) { cleanupErrors.push(error); }
    try {
      const resolvedProfile = resolve(profile);
      assert.ok(resolvedProfile.startsWith(resolve(tmpdir())), 'Refusing to clean a browser profile outside the temp directory');
      await runStage('temporary browser profile cleanup', () => rm(resolvedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }), {
        timeoutMs: 10_000,
        logger: { log() {}, error() {} },
      });
    } catch (error) { cleanupErrors.push(error); }
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Browser cleanup failed for started PID ${child.pid}`);
  })();

  try {
    const portFile = resolve(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 15_000;
    let port;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (signal?.aborted) throw signal.reason;
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`Browser exited before DevTools became available (${child.exitCode})\n${output.stderr || output.stdout}`);
      }
      try {
        [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
        if (port) break;
      } catch {}
      await abortableDelay(50, signal, { unref: true });
    }
    assert.ok(port, `Timed out waiting for browser DevTools endpoint (launcher exit ${child.exitCode ?? 'running'})\n${output.stderr || output.stdout}`);
    devtools = `http://127.0.0.1:${port}`;
    return browser;
  } catch (error) {
    try { await resources.closeBrowser(browser); }
    catch (cleanupError) {
      throw new SmokeCleanupError('Browser launch and cleanup failed', {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
}

async function closeCdp(cdp) {
  await resources.closeCdp(cdp);
}

async function openPage(devtools, url, preload = null, signal) {
  const listResponse = await fetchBounded(`${devtools}/json/list`, {}, 10_000, signal);
  assert.equal(listResponse.ok, true, `DevTools target list returned HTTP ${listResponse.status}`);
  let target = (await listResponse.json()).find(entry => entry.type === 'page');
  if (!target) {
    const response = await fetchBounded(`${devtools}/json/new?about:blank`, { method: 'PUT' }, 10_000, signal);
    assert.equal(response.ok, true, `DevTools target creation returned HTTP ${response.status}`);
    target = await response.json();
  }
  console.log(`DevTools target: ${target.type} ${target.url} (${target.webSocketDebuggerUrl})`);
  const cdp = new Cdp(target.webSocketDebuggerUrl, { signal });
  resources.trackCdp(cdp);
  let navigationStarted = false;
  try {
    await cdp.send('Runtime.enable', {}, { signal });
    await cdp.send('Page.enable', {}, { signal });
    await cdp.send('Log.enable', {}, { signal });
    await cdp.send('Network.enable', {}, { signal });
    if (preload) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preload }, { signal });
    navigationStarted = true;
    await cdp.send('Page.navigate', { url }, { signal });
    await cdp.waitFor(`document.readyState === 'complete'`, `Page did not load: ${url}`, 15_000, signal);
    return cdp;
  } catch (error) {
    await closeCdp(cdp);
    if (!navigationStarted && !signal?.aborted) {
      throw new EnvironmentBlockedError(`Browser DevTools page WebSocket is unavailable: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function consoleErrors(cdp) {
  return cdp.events.filter(event => {
    if (event.method === 'Runtime.exceptionThrown') return true;
    if (event.method === 'Runtime.consoleAPICalled') return event.params?.type === 'error';
    if (event.method === 'Log.entryAdded') {
      const entry = event.params?.entry;
      return entry?.level === 'error' && !entry.url?.endsWith('/favicon.ico');
    }
    return false;
  }).map(event => ({ method: event.method, params: event.params }));
}

async function screenshot(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const path = resolve(evidence, name);
  await writeFile(path, Buffer.from(result.data, 'base64'));
  return path;
}

async function memoryWebViewPreload() {
  const [globalText, levelText] = await Promise.all([
    readFile(resolve(root, '全局配置.json'), 'utf8'),
    readFile(resolve(root, 'level/关卡-001-直射引导.json'), 'utf8'),
  ]);
  return memoryWebViewPreloadSource(createSmokeWorkspaceFixture({ globalText, levelText }));
}

async function smokeProduction(cdp, url, expectedCanvas) {
  await cdp.waitFor(`document.querySelector('#save-state')?.dataset.state === 'readonly'`, 'Production browser mode did not become read-only', 15_000);
  const summary = await cdp.evaluate(`({
    url: location.href,
    readOnly: document.body.classList.contains('read-only'),
    saveState: document.querySelector('#save-state')?.textContent,
    editDisabled: document.querySelector('#edit-toggle')?.disabled,
    saveDisabled: document.querySelector('#save-button')?.disabled,
    canvas: { width: document.querySelector('#game-canvas')?.width, height: document.querySelector('#game-canvas')?.height },
    tabs: [...document.querySelectorAll('[data-tab]')].map(node => node.dataset.tab),
    resources: performance.getEntriesByType('resource').map(entry => decodeURIComponent(new URL(entry.name).pathname)),
  })`);
  assert.equal(summary.url, url);
  assert.equal(summary.readOnly, true);
  assert.match(summary.saveState, /只读演示模式/);
  assert.equal(summary.editDisabled, true);
  assert.equal(summary.saveDisabled, true);
  assert.deepEqual(summary.canvas, expectedCanvas);
  assert.deepEqual(summary.tabs, ['global', 'level', 'element']);
  assert.ok(summary.resources.some(path => path.endsWith('/全局配置.json')));
  await cdp.evaluate(`(() => {
    document.querySelector('#batch-level-button').click();
    document.querySelector('#batch-count').value = '5';
    document.querySelector('#batch-seed').value = 'browser-smoke-v2';
    document.querySelector('#batch-start').click();
  })()`);
  await cdp.waitFor(`document.querySelectorAll('#batch-cards .batch-card').length === 5`, 'v3 batch UI did not render five accepted candidates', 30_000);
  summary.batchV2 = await cdp.evaluate(`(() => ({
    title: document.querySelector('#batch-level-dialog .dialog-head')?.textContent,
    cards: document.querySelectorAll('#batch-cards .batch-card').length,
    normalPreviews: document.querySelectorAll('[data-preview="normal"]').length,
    structurePreviews: document.querySelectorAll('[data-preview="structure"]').length,
    metrics: [...document.querySelectorAll('[data-metrics]')].map(node => node.textContent),
    platformFilter: Boolean(document.querySelector('#batch-platform-filter')),
    noveltySort: [...document.querySelectorAll('#batch-sort option')].some(option => option.value === 'novelty'),
  }))()`);
  assert.match(summary.batchV2.title, /生成器 v3/);
  assert.equal(summary.batchV2.cards, 5);
  assert.equal(summary.batchV2.normalPreviews, 5);
  assert.equal(summary.batchV2.structurePreviews, 5);
  assert.ok(summary.batchV2.metrics.every(text => /轮廓 .*层级 .*稳定/.test(text)));
  assert.equal(summary.batchV2.platformFilter, true);
  assert.equal(summary.batchV2.noveltySort, true);
  summary.batchV2.interactions = await cdp.evaluate(`(async () => {
    const platform = document.querySelector('#batch-platform-filter');
    platform.value = 'double-3'; platform.dispatchEvent(new Event('change'));
    const platformCards = [...document.querySelectorAll('#batch-cards .batch-card:not(.batch-card-temporary)')];
    const platformFiltered = platformCards.length > 0 && platformCards.every(card => card.textContent.includes('double-3'));
    platform.value = ''; platform.dispatchEvent(new Event('change'));
    const topology = document.querySelector('#batch-topology-filter');
    topology.selectedIndex = 1; topology.dispatchEvent(new Event('change'));
    const topologyCards = [...document.querySelectorAll('#batch-cards .batch-card:not(.batch-card-temporary)')];
    const topologyFiltered = topologyCards.length > 0 && topologyCards.every(card => card.dataset.family === topology.value);
    topology.value = ''; topology.dispatchEvent(new Event('change'));
    const sort = document.querySelector('#batch-sort'); sort.value = 'novelty'; sort.dispatchEvent(new Event('change'));
    const similarities = [...document.querySelectorAll('#batch-cards [data-metrics]')].map(node => Number(node.textContent.match(/轮廓 ([0-9.]+)/)?.[1] ?? -1));
    const noveltySorted = similarities.every((value, index) => index === 0 || similarities[index - 1] <= value);
    const compareSource = [...document.querySelectorAll('#batch-cards .batch-card:not(.batch-card-temporary)')].find(card => {
      const button = card.querySelector('[data-action="compare"]');
      if (button?.disabled) return false;
      const nearestId = card.querySelector('[data-metrics]')?.textContent.match(/最近 ([^ ·]+)/)?.[1];
      const target = [...document.querySelectorAll('#batch-cards .batch-card:not(.batch-card-temporary)')].find(item => item.dataset.levelNumber === nearestId);
      return !target || target.dataset.family !== card.dataset.family
        || target.textContent.match(/(single-[35]|double-[23])/)?.[0] !== card.textContent.match(/(single-[35]|double-[23])/)?.[0];
    });
    const sourceNumber = compareSource?.dataset.levelNumber;
    const nearestId = compareSource?.querySelector('[data-metrics]')?.textContent.match(/最近 ([^ ·]+)/)?.[1];
    const target = [...document.querySelectorAll('#batch-cards .batch-card:not(.batch-card-temporary)')].find(card => card.dataset.levelNumber === nearestId);
    if (compareSource && target) {
      if (target.dataset.family !== compareSource.dataset.family) {
        topology.value = compareSource.dataset.family; topology.dispatchEvent(new Event('change'));
      } else {
        platform.value = compareSource.textContent.match(/(single-[35]|double-[23])/)?.[0] ?? '';
        platform.dispatchEvent(new Event('change'));
      }
    }
    const compare = [...document.querySelectorAll('#batch-cards .batch-card:not(.batch-card-temporary)')]
      .find(card => card.dataset.levelNumber === sourceNumber)?.querySelector('[data-action="compare"]');
    compare?.click();
    return { platformFiltered, topologyFiltered, noveltySorted, compareEnabled: Boolean(compare), temporaryCompare: Boolean(document.querySelector('.batch-card-temporary')) };
  })()`);
  assert.deepEqual(summary.batchV2.interactions, { platformFiltered: true, topologyFiltered: true, noveltySorted: true, compareEnabled: true, temporaryCompare: true });
  summary.batchV2.playAndResult = await cdp.evaluate(`(() => {
    const play = document.querySelector('#batch-cards [data-action="play"]');
    play?.click();
    const playStarted = play?.textContent === '退出试玩';
    play?.click();
    const result = document.querySelector('#batch-result-action');
    const resultLabel = result?.textContent;
    result?.click();
    return {
      playStarted,
      resultLabel,
      exported: document.querySelector('#batch-status')?.textContent,
      remainingCards: document.querySelectorAll('#batch-cards .batch-card:not(.batch-card-temporary)').length,
    };
  })()`);
  assert.deepEqual(summary.batchV2.playAndResult, {
    playStarted: true,
    resultLabel: '导出所选关卡',
    exported: '已导出 5 个关卡。',
    remainingCards: 0,
  });
  summary.presentationPixels = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('#game-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hud = 0;
    let walls = 0;
    let cannon = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      if (red >= 235 && green >= 238 && blue >= 240) hud += 1;
      if (red >= 235 && green >= 210 && blue <= 40) walls += 1;
      if (red >= 180 && red <= 215 && green >= 130 && green <= 180 && blue >= 55 && blue <= 110) cannon += 1;
    }
    return { hud, walls, cannon };
  })()`);
  assert.ok(summary.presentationPixels.hud > 1000, 'original HUD light panel must be present');
  assert.ok(summary.presentationPixels.walls > 100, 'original yellow projectile walls must be present');
  assert.ok(summary.presentationPixels.cannon > 100, 'original cannon base must be present');
  return summary;
}

async function dispatchMarquee(cdp, { start, end }) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.clientX, y: start.clientY, button: 'left', buttons: 1, clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: end.clientX, y: end.clientY, button: 'left', buttons: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: end.clientX, y: end.clientY, button: 'left', buttons: 0, clickCount: 1,
  });
}

async function emptyLevelForTerminalState(cdp, fileName) {
  const points = await cdp.evaluate(`(() => {
    document.querySelector('#edit-toggle').click();
    const fileName = ${JSON.stringify(fileName ?? null)};
    if (fileName) {
      [...document.querySelectorAll('.level-card')]
        .find(card => card.textContent.includes(fileName))
        .click();
    }
    const canvas = document.querySelector('#game-canvas');
    const rectangle = canvas.getBoundingClientRect();
    const scale = Math.min(canvas.width / 9, canvas.height / 16);
    const top = (canvas.height - 16 * scale) / 2;
    const point = (x, y) => ({ clientX: rectangle.left + x * scale * rectangle.width / canvas.width, clientY: rectangle.top + (top + y * scale) * rectangle.height / canvas.height });
    return { start: point(0.05, 0.05), end: point(8.95, 15.95) };
  })()`);
  await dispatchMarquee(cdp, points);
  return cdp.evaluate(`(() => {
    document.querySelector('[data-command="delete"]').click();
    const countText = document.querySelector('.level-card.active').textContent;
    document.querySelector('#edit-toggle').click();
    return { countText };
  })()`);
}

async function smokeWritable(cdp, parentSignal) {
  await cdp.waitFor(`document.querySelectorAll('.asset').length > 0 && !document.querySelector('#edit-toggle')?.disabled`, 'Memory WebView editor did not become writable', 15_000);
  const summary = {};

  summary.resourceAndMaterial = await stage('resource selection and material edit', () => cdp.evaluate(`(() => {
    const card = document.querySelector('.asset[data-kind="materials"]');
    card.querySelector('.asset-edit').click();
    const input = document.querySelector('[data-item-context="asset"] [data-asset-field="friction"]');
    const before = Number(input.value);
    input.value = String(before + 0.01);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      id: card.dataset.id,
      selected: document.querySelector('.asset[data-kind="materials"].selected')?.dataset.id === card.dataset.id,
      tab: document.querySelector('.tab.active')?.dataset.tab,
      before,
      after: Number(document.querySelector('[data-item-context="asset"] [data-asset-field="friction"]').value),
      dirty: document.querySelector('#save-state')?.dataset.state,
    };
  })()`), stageTimeoutMs, parentSignal, () => closeCdp(cdp));
  assert.equal(summary.resourceAndMaterial.selected, true);
  assert.equal(summary.resourceAndMaterial.tab, 'element');
  assert.equal(summary.resourceAndMaterial.after, summary.resourceAndMaterial.before + 0.01);
  assert.equal(summary.resourceAndMaterial.dirty, 'dirty');

  summary.dragDrop = await stage('enter edit mode and drag/drop asset', () => cdp.evaluate(`(() => {
    document.querySelector('#edit-toggle').click();
    const card = document.querySelector('.asset[data-kind="materials"]');
    const canvas = document.querySelector('#game-canvas');
    const objectCount = () => Number(document.querySelector('.level-card.active').textContent.match(/(\\d+) 个物品/)?.[1]);
    const beforeCount = objectCount();
    const rectangle = canvas.getBoundingClientRect();
    const transfer = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rectangle.left + rectangle.width * 0.55, clientY: rectangle.top + rectangle.height * 0.45 }));
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rectangle.left + rectangle.width * 0.55, clientY: rectangle.top + rectangle.height * 0.45 }));
    const object = JSON.parse(document.querySelector('#element-value').value);
    return {
      mode: document.querySelector('#edit-toggle').textContent,
      object,
      beforeCount,
      afterCount: objectCount(),
    };
  })()`), stageTimeoutMs, parentSignal, () => closeCdp(cdp));
  assert.equal(summary.dragDrop.mode, '退出编辑');
  assert.equal(summary.dragDrop.afterCount, summary.dragDrop.beforeCount + 1);
  assert.ok(summary.dragDrop.object.id);

  summary.moveRotate = await stage('keyboard move and rotate command', async () => {
    await cdp.evaluate(`document.querySelector('#game-canvas').focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    return cdp.evaluate(`(() => {
      const movedX = Number(document.querySelector('#element-x').value);
      const beforeAngle = Number(document.querySelector('#element-angle').value);
      document.querySelector('[data-command="rotate-right"]').click();
      return {
        startX: ${JSON.stringify(null)},
        movedX,
        beforeAngle,
        afterAngle: Number(document.querySelector('#element-angle').value),
      };
    })()`);
  }, stageTimeoutMs, parentSignal, () => closeCdp(cdp));
  summary.moveRotate.startX = summary.dragDrop.object.x;
  assert.equal(summary.moveRotate.movedX, summary.moveRotate.startX + 0.05);
  assert.ok(Math.abs(summary.moveRotate.afterAngle - summary.moveRotate.beforeAngle - 90) < 1e-9);

  summary.projectiles = await stage('play both projectile types', () => cdp.evaluate(`(() => {
    document.querySelector('#edit-toggle').click();
    const canvas = document.querySelector('#game-canvas');
    const rectangle = canvas.getBoundingClientRect();
    const fire = () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rectangle.left + rectangle.width * 0.5, clientY: rectangle.top + rectangle.height * 0.45 }));
    const normalBefore = Number(document.querySelector('[data-ammo="normal"]').textContent);
    fire();
    const normalAfter = Number(document.querySelector('[data-ammo="normal"]').textContent);
    document.querySelector('[data-projectile="explosive"]').click();
    const explosiveSelected = document.querySelector('[data-projectile="explosive"]').getAttribute('aria-pressed');
    const explosiveBefore = Number(document.querySelector('[data-ammo="explosive"]').textContent);
    fire();
    const explosiveAfter = Number(document.querySelector('[data-ammo="explosive"]').textContent);
    return {
      mode: document.querySelector('#edit-toggle').textContent,
      normalBefore, normalAfter, explosiveBefore, explosiveAfter, explosiveSelected,
    };
  })()`), stageTimeoutMs, parentSignal, () => closeCdp(cdp));
  assert.equal(summary.projectiles.mode, '进入编辑');
  assert.equal(summary.projectiles.normalAfter, summary.projectiles.normalBefore - 1);
  assert.equal(summary.projectiles.explosiveSelected, 'true');
  assert.equal(summary.projectiles.explosiveAfter, summary.projectiles.explosiveBefore - 1);

  summary.emptyForNext = await stage('select and delete all objects', () => emptyLevelForTerminalState(cdp), stageTimeoutMs, parentSignal, () => closeCdp(cdp));
  assert.match(summary.emptyForNext.countText, /0 个物品/);
  await stage('wait for first terminal play state', () => cdp.waitFor(`!document.querySelector('#play-result').hidden`, 'Empty edited level did not reach a terminal state', 10_000), 12_000, parentSignal, () => closeCdp(cdp));

  summary.next = await stage('advance only after the first won terminal state', () => cdp.evaluate(`(() => {
    const nextDisabled = document.querySelector('#next-level').disabled;
    document.querySelector('#next-level').click();
    return { nextDisabled, nextLevel: Number(document.querySelector('#level-number').value) };
  })()`), stageTimeoutMs, parentSignal, () => closeCdp(cdp));
  assert.equal(summary.next.nextDisabled, false);
  assert.equal(summary.next.nextLevel, 2);

  summary.secondEmpty = await stage('make the next level terminal for retry coverage', () => emptyLevelForTerminalState(cdp, 'level-smoke-2.json'), stageTimeoutMs, parentSignal, () => closeCdp(cdp));
  assert.match(summary.secondEmpty.countText, /0 个物品/);
  await stage('wait for second terminal play state', () => cdp.waitFor(`!document.querySelector('#play-result').hidden`, 'Second empty level did not reach a terminal state', 10_000), 12_000, parentSignal, () => closeCdp(cdp));

  summary.retryAndEdit = await stage('retry the terminal level and return to edit mode', () => cdp.evaluate(`(() => {
    const terminalVisible = !document.querySelector('#play-result').hidden;
    const beforeLevel = Number(document.querySelector('#level-number').value);
    document.querySelector('#retry-level').click();
    const retryLevel = Number(document.querySelector('#level-number').value);
    document.querySelector('#edit-toggle').click();
    return {
      terminalVisible,
      beforeLevel,
      retryLevel,
      finalMode: document.querySelector('#edit-toggle').textContent,
      editingClass: document.querySelector('.canvas-area').classList.contains('editing'),
    };
  })()`), stageTimeoutMs, parentSignal, () => closeCdp(cdp));
  assert.equal(summary.retryAndEdit.terminalVisible, true);
  assert.equal(summary.retryAndEdit.beforeLevel, 2);
  assert.equal(summary.retryAndEdit.retryLevel, 2);
  assert.equal(summary.retryAndEdit.finalMode, '退出编辑');
  assert.equal(summary.retryAndEdit.editingClass, true);
  return summary;
}

let cleanupPromise = null;

function cleanupStartedResources() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const errors = [];
    for (const cdp of [...resources.cdps]) {
      try { await closeCdp(cdp); } catch (error) { errors.push(error); }
    }
    for (const browser of [...resources.browsers]) {
      try { await resources.closeBrowser(browser); } catch (error) { errors.push(error); }
    }
    for (const server of [...resources.servers]) {
      try { await resources.closeServer(server); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Smoke cleanup failed');
  })().finally(() => { cleanupPromise = null; });
  return cleanupPromise;
}

async function main(overallSignal) {
  const globalDocument = JSON.parse(await readFile(resolve(root, '全局配置.json'), 'utf8'));
  const config = { canvas: globalDocument.canvas };
  const server = await stage('HTTP server startup', signal => serveWorkspace(signal), stageTimeoutMs, overallSignal);
  resources.trackServer(server);
  console.log(`Smoke server: ${server.baseUrl}`);
  let browser;
  try {
    browser = await stage('Edge/Chrome launch and DevTools discovery', signal => launchBrowser(signal), 35_000, overallSignal);
  } catch (error) {
    if (error instanceof EnvironmentBlockedError || error instanceof SmokeCleanupError || overallSignal.aborted) throw error;
    throw new EnvironmentBlockedError(`Browser launch or DevTools discovery is unavailable: ${error.message}`, { cause: error });
  }
  runDiagnostics.browserExecutable = browser.executable;
  console.log(`Browser: ${browser.executable} (pid ${browser.pid})`);
  const summary = { browser: { executable: browser.executable, pid: browser.pid, devtools: browser.devtools } };
  try {
    const version = await stage('DevTools version query', async signal => (await fetchBounded(`${browser.devtools}/json/version`, {}, 10_000, signal)).json(), stageTimeoutMs, overallSignal);
    summary.browser.product = version.Browser;
    runDiagnostics.browserProduct = version.Browser;
  } catch (error) {
    if (overallSignal.aborted) throw error;
    throw new EnvironmentBlockedError(`Browser DevTools HTTP endpoint is unavailable: ${error.message}`, { cause: error });
  }

  const productionUrl = new URL('index.html', server.baseUrl).href;
  const production = await stage('open production browser page', signal => openPage(browser.devtools, productionUrl, null, signal), stageTimeoutMs, overallSignal);
  try {
    await stage('production browser read-only assertions', async () => {
      summary.production = await smokeProduction(production, productionUrl, config.canvas);
      summary.productionConsoleErrors = consoleErrors(production);
      assert.deepEqual(summary.productionConsoleErrors, []);
    }, stageTimeoutMs, overallSignal, () => closeCdp(production));
  } finally { await closeCdp(production); }

  const writable = await stage('open writable memory-WebView page', async signal => openPage(
    browser.devtools,
    new URL('index.html?smoke=memory-webview', server.baseUrl).href,
    await memoryWebViewPreload(),
    signal,
  ), stageTimeoutMs, overallSignal);
  try {
    summary.writable = await stage('writable editor interaction suite', signal => smokeWritable(writable, signal), 70_000, overallSignal, () => closeCdp(writable));
    await stage('writable console and screenshot evidence', async () => {
      summary.writableConsoleErrors = consoleErrors(writable);
      assert.deepEqual(summary.writableConsoleErrors, []);
      summary.screenshot = await screenshot(writable, 'task-6-browser-smoke.png');
    }, stageTimeoutMs, overallSignal, () => closeCdp(writable));
  } finally { await closeCdp(writable); }

  summary.status = 'PASS';
  return summary;
}

async function writeFailureEvidence(status, error) {
    const failurePath = resolve(evidence, 'task-6-browser-smoke-failure.json');
    try {
      await writeFile(failurePath, `${JSON.stringify({
        status,
        failedStage,
        error: { name: error?.name, message: error?.message },
        diagnostics: runDiagnostics,
      }, null, 2)}\n`);
      console.error(`Browser smoke failure evidence: ${failurePath}`);
    } catch (writeError) {
      console.error(`Could not write browser smoke failure evidence: ${writeError.message}`);
    }
}

async function runCli() {
  await ensureEvidenceDirectory();
  await invalidatePassEvidence();
  const overallController = new AbortController();
  let forceExitTimer = null;
  let resourcesClosed = false;
  let status = 'PASS';
  let failure = null;
  let summary = null;
  const overallTimer = setTimeout(() => {
    failedStage ??= 'overall smoke hard timeout';
    failure = new SmokeTimeoutError(`Overall smoke run exceeded hard timeout ${overallTimeoutMs}ms`);
    status = 'FAIL';
    process.exitCode = 1;
    overallController.abort(failure);
    forceExitTimer = setTimeout(() => {
      console.error('[smoke] FAIL cleanup did not finish after overall timeout; forcing non-zero exit');
      process.exit(1);
    }, 20_000);
  }, overallTimeoutMs);

  try {
    summary = await main(overallController.signal);
  } catch (error) {
    failure = error;
    status = error instanceof EnvironmentBlockedError ? 'ENVIRONMENT_BLOCKED' : 'FAIL';
  } finally {
    try {
      await cleanupStartedResources();
      resourcesClosed = resources.isEmpty;
      if (!resourcesClosed) throw new Error('Smoke cleanup returned without closing every tracked resource');
    } catch (cleanupError) {
      const cleanupMessages = error => [error?.message, ...(error instanceof AggregateError ? error.errors.flatMap(cleanupMessages) : [])];
      console.error(`[smoke] Cleanup failure: ${cleanupMessages(cleanupError).filter(Boolean).join(' | ')}`);
      failure = failure ? new AggregateError([failure, cleanupError], 'Smoke run and cleanup failed') : cleanupError;
      status = 'FAIL';
    }
    if (resourcesClosed) {
      clearTimeout(overallTimer);
      clearTimeout(forceExitTimer);
    } else if (!forceExitTimer) {
      forceExitTimer = setTimeout(() => process.exit(1), 1_000);
    }
  }

  if (status === 'PASS') {
    try {
      await commitPassEvidence({ passPath: passEvidencePath, status, resourcesClosed, summary });
      console.log(JSON.stringify({ ...summary, evidence: passEvidencePath }, null, 2));
    } catch (error) {
      failure = error;
      status = 'FAIL';
    }
  } else {
    await invalidatePassEvidence();
  }

  console.log(`Browser smoke result: ${status}`);
  if (status !== 'PASS') {
    await writeFailureEvidence(status, failure);
    console.error(failure?.stack ?? failure);
    process.exitCode = status === 'ENVIRONMENT_BLOCKED' ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
