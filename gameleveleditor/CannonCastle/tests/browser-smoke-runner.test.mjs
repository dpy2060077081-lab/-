import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as runner from './browser-smoke-runner.mjs';

test('PASS evidence is invalidated first and committed atomically only after clean resource shutdown', async () => {
  assert.equal(typeof runner.invalidatePassEvidence, 'function');
  assert.equal(typeof runner.commitPassEvidence, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'meteor-smoke-evidence-test-'));
  const passPath = join(directory, 'pass.json');
  await writeFile(passPath, '{"status":"STALE_PASS"}\n');

  await runner.invalidatePassEvidence(passPath);
  await assert.rejects(() => readFile(passPath, 'utf8'), error => error.code === 'ENOENT');

  assert.equal(await runner.commitPassEvidence({ passPath, status: 'PASS', resourcesClosed: false, summary: { status: 'PASS' } }), false);
  await assert.rejects(() => readFile(passPath, 'utf8'), error => error.code === 'ENOENT');

  assert.equal(await runner.commitPassEvidence({ passPath, status: 'PASS', resourcesClosed: true, summary: { status: 'PASS', marker: 1 } }), true);
  assert.deepEqual(JSON.parse(await readFile(passPath, 'utf8')), { status: 'PASS', marker: 1 });

  const nestedPassPath = join(directory, 'new-evidence-directory', 'pass.json');
  assert.equal(await runner.commitPassEvidence({ passPath: nestedPassPath, status: 'PASS', resourcesClosed: true, summary: { status: 'PASS', marker: 3 } }), true);
  assert.deepEqual(JSON.parse(await readFile(nestedPassPath, 'utf8')), { status: 'PASS', marker: 3 });

  await assert.rejects(() => runner.commitPassEvidence({
    passPath,
    status: 'PASS',
    resourcesClosed: true,
    summary: { status: 'PASS', marker: 2 },
    renameFile: async () => { throw new Error('cleanup gate denied commit'); },
  }), /cleanup gate denied commit/);
  await assert.rejects(() => readFile(passPath, 'utf8'), error => error.code === 'ENOENT');
});

test('browser runner serves and targets a real non-root HTTP subpath', async () => {
  assert.equal(typeof runner.serveWorkspace, 'function');
  const server = await runner.serveWorkspace();
  try {
    const base = new URL(server.baseUrl);
    assert.notEqual(base.pathname, '/');
    assert.match(base.pathname, /^\/.+\/$/);
    assert.equal((await fetch(new URL('index.html', base))).status, 200);
    assert.equal((await fetch(new URL('/index.html', base))).status, 404);
  } finally {
    await server.close();
  }
});

test('browser resource assertions decode Unicode URL pathnames before comparison', async () => {
  const source = await readFile(new URL('./browser-smoke-runner.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /resources:\s*performance\.getEntriesByType\('resource'\)\.map\(entry => decodeURIComponent\(new URL\(entry\.name\)\.pathname\)\)/,
  );
});
