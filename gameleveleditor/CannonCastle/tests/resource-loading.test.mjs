import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = dirname(root);
const nestedBase = `${basename(root)}/`;
const resources = [
  'index.html',
  'static/css/editor.css',
  'static/js/editor.js',
  'static/js/editor-host.js',
  'static/js/editor-state.js',
  'static/js/canvas-editor.js',
  'static/js/file-transfer.js',
  'static/js/level-config.js',
  'static/js/level-library-controller.js',
  'static/js/play-session.js',
  'gamelogic.js',
  'levellist.js',
  '全局配置.json',
  'level/导出清单.json',
  'level/关卡-001-直射引导.json',
];

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveWorkspace() {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relative = pathname.replace(/^\/+/, '') || `${nestedBase}index.html`;
    const target = resolve(serverRoot, relative);
    const serverPrefix = serverRoot.endsWith(sep) ? serverRoot : `${serverRoot}${sep}`;
    if (target !== serverRoot && !target.startsWith(serverPrefix)) {
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

  return new Promise((resolveListening) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveListening({
        baseUrl: `http://127.0.0.1:${address.port}/${nestedBase}`,
        close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
      });
    });
  });
}

function runVerifier(args = []) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['scripts/verify.mjs', ...args], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('all browser resources load from a nested relative-path HTTP base', async () => {
  const server = await serveWorkspace();
  try {
    assert.match(server.baseUrl, new RegExp(`/${basename(root)}/$`));

    for (const resource of resources) {
      const response = await fetch(new URL(resource, server.baseUrl));
      assert.equal(response.status, 200, `${resource} returned HTTP ${response.status}`);
      assert.ok((await response.arrayBuffer()).byteLength > 0, `${resource} was empty`);
    }
  } finally {
    await server.close();
  }
});

test('the verifier skip-browser mode is explicitly static diagnostics rather than a full pass', async () => {
  const result = await runVerifier(['--skip-browser']);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /JSON files parsed:/);
  assert.match(result.stdout, /JavaScript files checked:/);
  assert.match(result.stdout, /Pure modules imported:/);
  assert.match(result.stdout, /Level files validated:/);
  assert.match(result.stdout, /Legacy round trips:/);
  assert.match(result.stdout, /Production guards: original runtime/);
  assert.match(result.stdout, /Browser smoke: SKIPPED/);
  assert.match(result.stdout, /static diagnostics only/i);
  assert.doesNotMatch(result.stdout, /Verification passed\./);
});
