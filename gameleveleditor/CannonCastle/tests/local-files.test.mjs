import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFiles, waitForLocalFiles } from '../static/js/local-files.js';

test('LocalFiles unwraps successful envelopes and preserves the documented API arguments', async () => {
  const calls = [];
  const api = new Proxy({}, {
    get(_target, method) {
      return async (...args) => {
        calls.push([method, ...args]);
        return { ok: true, data: { method, args } };
      };
    },
  });
  const files = new LocalFiles(api);

  assert.deepEqual(await files.list('level'), { method: 'list_dir', args: ['level'] });
  assert.deepEqual(await files.readText('全局配置.json'), { method: 'read_text', args: ['全局配置.json'] });
  assert.deepEqual(await files.readBase64('level/asset/existing.png'), {
    method: 'read_base64', args: ['level/asset/existing.png'],
  });
  assert.deepEqual(await files.writeText('level/level-55.json', '{}', false), {
    method: 'write_text', args: ['level/level-55.json', '{}', false],
  });
  assert.deepEqual(await files.writeBase64('level/asset/new.png', 'abc', false), {
    method: 'write_base64', args: ['level/asset/new.png', 'abc', false],
  });
  assert.deepEqual(await files.remove('level/old.json', false), {
    method: 'delete', args: ['level/old.json', false],
  });
  assert.deepEqual(calls.map(([method]) => method), ['list_dir', 'read_text', 'read_base64', 'write_text', 'write_base64', 'delete']);
});

test('LocalFiles exposes backend error codes and rejects paths outside the executable workspace', async () => {
  let calls = 0;
  const files = new LocalFiles({
    async read_text() {
      calls += 1;
      return { ok: false, error: { code: 'NOT_FOUND', message: 'missing' } };
    },
  });

  await assert.rejects(() => files.readText('missing.json'), error => error.code === 'NOT_FOUND' && error.message === 'missing');
  assert.throws(() => files.readText('../outside.json'), error => error.code === 'INVALID_PATH');
  assert.throws(() => files.writeText('C:/outside.json', '{}'), error => error.code === 'INVALID_PATH');
  assert.throws(() => files.remove('/outside.json'), error => error.code === 'INVALID_PATH');
  assert.equal(calls, 1);
});

test('waitForLocalFiles does not expose the API until pywebviewready fires', async () => {
  let readyListener;
  const api = { async list_dir() { return { ok: true, data: { entries: [] } }; } };
  const target = {
    pywebview: { api: { files: api } },
    addEventListener(type, listener, options) {
      assert.equal(type, 'pywebviewready');
      assert.deepEqual(options, { once: true });
      readyListener = listener;
    },
  };
  let settled = false;
  const pending = waitForLocalFiles(target).then(files => {
    settled = true;
    return files;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  readyListener();
  assert.equal((await pending).api, api);
});
